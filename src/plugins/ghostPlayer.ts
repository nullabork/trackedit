import { BoxGeometry, DoubleSide, Group, Matrix4, Mesh, MeshLambertMaterial, Quaternion, SRGBColorSpace, TextureLoader, Vector3 } from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { lineHue } from "@core/layer";
import type { GhostPath, Layer } from "@core/layer";
import { buildTimeline, sampleTimeline, stepTime } from "@core/ghostPlayback";
import type { PlaybackTimeline } from "@core/ghostPlayback";
import { toWorld } from "@core/waypoints";
import { createPlaybackBar } from "@ui/PlaybackBar";
import type { EditorContext, EditorPlugin } from "./api";

/**
 * Plays the selected driving line back.
 *
 * Selecting a line in the Layers list puts a car marker at its start — a box turned like the
 * car's body in the ghost (heading, pitch, roll; along the direction of travel when the ghost
 * has no rotations) — and a floating bar at the bottom of the viewport: play / pause,
 * speed, steps (hold to accelerate), previous / next checkpoint, a scrubber, and the
 * driver's inputs. Only the line itself plays: tries that ended in a respawn before the next
 * checkpoint are skipped (core/ghostPlayback).
 *
 * Follow puts the camera behind the car, relative to its heading and pitch — never its roll;
 * dragging orbits around it, the wheel zooms, and moving away (pan, fly, WASD) switches it
 * off. First person rides in the car and rolls with it.
 */
export const ghostPlayerPlugin: EditorPlugin = {
  id: "builtin.ghostPlayer",
  name: "Driving line playback",
  init(ctx: EditorContext): void {
    let selected: { layerId: string; key: string } | null = null;
    /** The timeline belongs to the samples it was built from. */
    let timeline: { of: GhostPath["path"]; checkpoints: GhostPath["checkpoints"]; built: PlaybackTimeline } | null = null;
    let time = 0;
    let playing = false;
    let speed = 1;
    let follow = false;
    let firstPerson = false;
    /** "Hide line": the tube is out of view while playing or following (not saved; the line stays loaded). */
    let hideLine = false;
    /** "Repeat": the run starts over when it ends. */
    let repeat = false;
    let hidden: { layerId: string; key: string } | null = null;
    const setHidden = (line: { layerId: string; key: string } | null) => {
      if (hidden && (!line || line.layerId !== hidden.layerId || line.key !== hidden.key))
        ctx.events.emit("linePlaybackHidden", { ...hidden, hidden: false });
      if (line && (!hidden || line.layerId !== hidden.layerId || line.key !== hidden.key))
        ctx.events.emit("linePlaybackHidden", { ...line, hidden: true });
      hidden = line;
    };
    let last = performance.now();

    const car = buildCar();
    car.visible = false;
    // The real car replaces the box once it has loaded (when the import has one).
    void loadCarModel().then((model) => {
      if (!model) return;
      for (const child of [...car.children]) car.remove(child);
      car.add(model.object);
      car.userData.tinted = model.tinted;
      car.userData.lift = 0; // the model's origin is on the road under it, like the ghost's position
    });

    const current = (): { layer: Layer; ghost: GhostPath; index: number } | null => {
      if (!selected) return null;
      const layer = ctx.document.getLayer(selected.layerId);
      const index = layer?.ghosts.findIndex((g) => g.key === selected!.key) ?? -1;
      return layer && index >= 0 ? { layer, ghost: layer.ghosts[index], index } : null;
    };
    const timelineOf = (ghost: GhostPath): PlaybackTimeline => {
      if (!timeline || timeline.of !== ghost.path || timeline.checkpoints !== ghost.checkpoints)
        timeline = { of: ghost.path, checkpoints: ghost.checkpoints, built: buildTimeline(ghost) };
      return timeline.built;
    };

    const setFollow = (on: boolean) => {
      follow = on;
      if (!on) { firstPerson = false; ctx.view.rig.endFollow(); }
    };
    ctx.view.rig.onFollowEnded = () => { follow = false; firstPerson = false; };

    const bar = createPlaybackBar({
      onPlayPause: () => {
        const c = current();
        if (!c) return;
        // Play from the end = play again.
        if (!playing && time >= timelineOf(c.ghost).duration) time = 0;
        playing = !playing;
      },
      onSeek: (ms) => { time = ms; },
      onStep: (samples) => {
        const c = current();
        if (!c) return;
        playing = false;
        time = stepTime(timelineOf(c.ghost), time, samples);
      },
      onCheckpoint: (direction) => {
        const c = current();
        if (!c) return;
        const stops = [0, ...timelineOf(c.ghost).checkpoints];
        // Going back from just after a checkpoint lands on the one before it, like a CD player.
        const next = direction > 0 ? stops.find((s) => s > time + 1) : [...stops].reverse().find((s) => s < time - 400);
        time = next ?? (direction > 0 ? timelineOf(c.ghost).duration : 0);
      },
      onSpeed: (s) => { speed = s; },
      onFollow: (on) => setFollow(on),
      onFirstPerson: (on) => { firstPerson = on; if (on) follow = true; },
      onHideLine: (on) => { hideLine = on; },
      onRepeat: (on) => { repeat = on; },
      onClose: () => ctx.events.emit("lineSelected", { line: null }),
    });
    bar.element.hidden = true;
    (ctx.view.canvas.parentElement ?? document.body).append(bar.element);

    ctx.events.on("lineSelected", ({ line }) => {
      const same = !!line && !!selected && line.layerId === selected.layerId && line.key === selected.key;
      selected = line;
      if (same) return;
      time = 0;
      playing = false;
      setFollow(false);
    });
    // Server tracking (and anything else) drives the bar's buttons without the bar.
    ctx.events.on("playbackCommand", (cmd) => {
      const c = current();
      if (!c) return;
      if (cmd.repeat !== undefined) repeat = cmd.repeat;
      if (cmd.hideLine !== undefined) hideLine = cmd.hideLine;
      if (cmd.follow !== undefined) setFollow(cmd.follow);
      if (cmd.firstPerson !== undefined) { firstPerson = cmd.firstPerson; if (cmd.firstPerson) follow = true; }
      if (cmd.play !== undefined) {
        if (cmd.play && time >= timelineOf(c.ghost).duration) time = 0;
        playing = cmd.play;
      }
    });

    const up = new Vector3(0, 1, 0), x = new Vector3(), y = new Vector3(), z = new Vector3();
    const basis = new Matrix4(), turn = new Quaternion(), nose = new Vector3();
    ctx.view.onFrame(() => {
      const now = performance.now();
      const dt = Math.min(now - last, 100); // a background tab must not fast-forward the run
      last = now;
      const c = current();
      if (!c || c.ghost.visible === false || !c.layer.visible || c.ghost.path.length < 2) {
        if (selected && !c) selected = null;
        if (follow) setFollow(false);
        setHidden(null);
        car.visible = false;
        bar.element.hidden = true;
        return;
      }
      const tl = timelineOf(c.ghost);
      if (playing) {
        time += dt * speed;
        if (time >= tl.duration) {
          if (repeat) time = 0;
          else { time = tl.duration; playing = false; }
        }
      }
      const s = sampleTimeline(c.ghost, tl, time);
      if (!s) return;
      setHidden(hideLine && (playing || follow) ? { layerId: c.layer.id, key: c.ghost.key } : null);

      // The marker lives in the layer's group, like the line: layer-local coordinates.
      const group = ctx.renderer.getLayerGroup(c.layer.id);
      if (group && car.parent !== group) group.add(car);
      if (s.quat) {
        // The body as the ghost recorded it: heading, pitch AND roll — sideways in a drift,
        // banked on a wall ride, upside down at the top of a loop.
        turn.set(s.quat[0], s.quat[1], s.quat[2], s.quat[3]);
      } else {
        // No orientation in the ghost: lie along the direction of travel, wheels down.
        z.set(s.forward[0], s.forward[1], s.forward[2]);
        x.crossVectors(up, z);
        if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
        x.normalize();
        y.crossVectors(z, x);
        turn.setFromRotationMatrix(basis.makeBasis(x, y, z));
      }
      car.quaternion.copy(turn);
      car.position.set(s.pos[0], s.pos[1] + ((car.userData.lift as number | undefined) ?? CAR_LIFT), s.pos[2]);
      car.visible = !(follow && firstPerson);
      // Body in the line's hue, its untextured panels a shade darker.
      const [body, panels] = car.userData.tinted as MeshLambertMaterial[];
      body.color.set(lineHue(c.index));
      panels?.color.set(lineHue(c.index)).multiplyScalar(0.72);

      if (follow) {
        // The camera works in world space; the line may sit in a moved or turned layer.
        // Where the NOSE points (the body, when the ghost has it — else the direction of travel).
        nose.set(0, 0, 1).applyQuaternion(turn);
        const [p, ahead] = toWorld(c.layer, [s.pos, [s.pos[0] + nose.x, s.pos[1] + nose.y, s.pos[2] + nose.z]]);
        const dx = ahead[0] - p[0], dy = ahead[1] - p[1], dz = ahead[2] - p[2];
        const heading = Math.atan2(dx, dz), pitch = Math.asin(Math.min(1, Math.max(-1, dy)));
        // The full attitude is only handed over when the layer is not turned itself.
        const t = c.layer.transform;
        const plain = t.rotDeg[0] === 0 && t.rotDeg[1] === 0 && t.rotDeg[2] === 0;
        ctx.view.rig.follow(new Vector3(p[0], p[1] + CAR_LIFT, p[2]), heading, pitch, firstPerson, plain ? turn : null);
        // The frame loop moves the camera BEFORE it calls us, so without this the camera aims
        // at where the car was a frame ago: about a metre at 200 km/h, and several whenever a
        // frame runs long (moving the mouse did it) — the car seemed to jump ahead and back.
        ctx.view.rig.update(0);
      }

      bar.element.hidden = false;
      bar.update({
        label: c.ghost.driver ?? c.ghost.label,
        hue: lineHue(c.index),
        time, duration: tl.duration, raceTime: s.raceTime,
        checkpoints: tl.checkpoints, checkpointsTaken: s.checkpointsTaken,
        playing, speed, follow, firstPerson, hideLine, repeat,
        steer: s.steer, gas: s.gas, brake: s.brake, kmh: s.speed,
      });
    });
  },
};

/** The stand-in box is centred on its middle; lift it so it sits on the road rather than in it. */
const CAR_LIFT = 0.4;

/**
 * The game's car (meshdump car -> meshes/car/): the Stadium model, its body tinted in the
 * line's hue through `body`. Null when the import has none — the box stays.
 */
async function loadCarModel(): Promise<{ object: Group; tinted: MeshLambertMaterial[] } | null> {
  try {
    const res = await fetch("meshes/car/index.json");
    if (!res.ok) return null;
    const index = (await res.json()) as Record<string, { obj: string; materials: Record<string, string | null> } | undefined>;
    const entry = index.Stadium ?? Object.values(index)[0];
    if (!entry) return null;
    const textures = new TextureLoader();
    const body = new MeshLambertMaterial({ color: 0x2dd4bf, side: DoubleSide });
    // Body panels that come without a base-colour texture (the prestige skin's "medal" metal:
    // the rear cover and more) are painted like the body.
    const panels = new MeshLambertMaterial({ color: 0x2dd4bf, side: DoubleSide });
    const materialFor = (name: string): MeshLambertMaterial => {
      const file = entry.materials[name];
      const map = file ? textures.load("meshes/" + file) : null;
      if (map) map.colorSpace = SRGBColorSpace;
      if (name === "Skin") { body.map = map; return body; }
      if (name.startsWith("Prestige")) return panels;
      if (name.startsWith("Glass")) return new MeshLambertMaterial({ color: 0x0b1116, transparent: true, opacity: 0.75, side: DoubleSide });
      return new MeshLambertMaterial({ map, color: map ? 0xffffff : 0x3a4350, side: DoubleSide });
    };
    const cache = new Map<string, MeshLambertMaterial>();
    const named = (name: string) => cache.get(name) ?? cache.set(name, materialFor(name)).get(name)!;
    const object = await new OBJLoader().loadAsync("meshes/" + entry.obj);
    object.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.computeVertexNormals();
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => named(m.name)) : named(mesh.material.name);
      mesh.raycast = () => {};
    });
    object.name = "ghost-car-model";
    return { object, tinted: [body, panels] };
  } catch {
    return null;
  }
}

/** The car: a box the size of one, lying along +z (its direction of travel), nose marked. */
function buildCar(): Group {
  const body = new MeshLambertMaterial({ color: 0x2dd4bf, emissive: 0x111111 });
  const car = new Group();
  const hull = new Mesh(new BoxGeometry(2.2, 1.1, 4.6), body);
  const nose = new Mesh(new BoxGeometry(2.2, 0.5, 0.9), new MeshLambertMaterial({ color: 0xffffff, emissive: 0x666666 }));
  nose.position.set(0, 0.2, 2.3);
  const cabin = new Mesh(new BoxGeometry(1.5, 0.6, 1.8), new MeshLambertMaterial({ color: 0x10151a }));
  cabin.position.set(0, 0.8, -0.4);
  car.add(hull, nose, cabin);
  car.name = "ghost-car";
  car.userData.tinted = [body];
  car.traverse((o) => { o.raycast = () => {}; });
  return car;
}
