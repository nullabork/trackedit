import { BoxGeometry, Group, Matrix4, Mesh, MeshLambertMaterial, Quaternion, Vector3 } from "three";
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
 * Selecting a line in the Layers list puts a car marker at its start — a box lying along
 * the direction of travel — and a floating bar at the bottom of the viewport: play / pause,
 * speed, steps (hold to accelerate), previous / next checkpoint, a scrubber, and the
 * driver's inputs. Only the line itself plays: tries that ended in a respawn before the next
 * checkpoint are skipped (core/ghostPlayback).
 *
 * Follow puts the camera behind the car, relative to its heading; dragging orbits around
 * it, the wheel zooms, and moving away (pan, fly, WASD) switches it off. First person rides
 * in the car.
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
    let last = performance.now();

    const car = buildCar();
    car.visible = false;

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

    const up = new Vector3(0, 1, 0), x = new Vector3(), y = new Vector3(), z = new Vector3();
    const basis = new Matrix4(), turn = new Quaternion();
    ctx.view.onFrame(() => {
      const now = performance.now();
      const dt = Math.min(now - last, 100); // a background tab must not fast-forward the run
      last = now;
      const c = current();
      if (!c || c.ghost.visible === false || !c.layer.visible || c.ghost.path.length < 2) {
        if (selected && !c) selected = null;
        if (follow) setFollow(false);
        car.visible = false;
        bar.element.hidden = true;
        return;
      }
      const tl = timelineOf(c.ghost);
      if (playing) {
        time += dt * speed;
        if (time >= tl.duration) { time = tl.duration; playing = false; }
      }
      const s = sampleTimeline(c.ghost, tl, time);
      if (!s) return;

      // The marker lives in the layer's group, like the line: layer-local coordinates.
      const group = ctx.renderer.getLayerGroup(c.layer.id);
      if (group && car.parent !== group) group.add(car);
      z.set(s.forward[0], s.forward[1], s.forward[2]);
      x.crossVectors(up, z);
      if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
      x.normalize();
      y.crossVectors(z, x);
      car.quaternion.copy(turn.setFromRotationMatrix(basis.makeBasis(x, y, z)));
      car.position.set(s.pos[0], s.pos[1] + CAR_LIFT, s.pos[2]);
      car.visible = !(follow && firstPerson);
      (car.userData.body as MeshLambertMaterial).color.set(lineHue(c.index));

      if (follow) {
        // The camera works in world space; the line may sit in a moved or turned layer.
        const [p, ahead] = toWorld(c.layer, [s.pos, [s.pos[0] + s.forward[0], s.pos[1] + s.forward[1], s.pos[2] + s.forward[2]]]);
        const heading = Math.atan2(ahead[0] - p[0], ahead[2] - p[2]);
        ctx.view.rig.follow(new Vector3(p[0], p[1] + CAR_LIFT, p[2]), heading, firstPerson);
      }

      bar.element.hidden = false;
      bar.update({
        label: c.ghost.driver ?? c.ghost.label,
        hue: lineHue(c.index),
        time, duration: tl.duration, raceTime: s.raceTime,
        checkpoints: tl.checkpoints, checkpointsTaken: s.checkpointsTaken,
        playing, speed, follow, firstPerson,
        steer: s.steer, gas: s.gas, brake: s.brake, kmh: s.speed,
      });
    });
  },
};

/** Ghost samples are the car's centre, which rides a little above the road. */
const CAR_LIFT = 0.4;

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
  car.userData.body = body;
  car.traverse((o) => { o.raycast = () => {}; });
  return car;
}
