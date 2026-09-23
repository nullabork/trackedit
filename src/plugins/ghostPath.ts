import {
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  Float32BufferAttribute,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import { BufferGeometry } from "three";
import type { Object3D } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Vec3 } from "@core/math";
import { DEFAULT_ATTEMPT_OPACITY, lineHue } from "@core/layer";
import type { GhostPath } from "@core/layer";
import { splitGhostRuns } from "@core/ghostRuns";
import type { EditorContext, EditorPlugin } from "./api";
import { onPassesChanged, passesOf } from "./linePasses";

const START = new Color(0x35d07f);
const END = new Color(0xff4d4d);
/** How far above the line a checkpoint number floats (metres). */
const NUMBER_LIFT = 6;
/** Fallback tube radius in metres (render prefs override it). */
const DEFAULT_RADIUS = 1.2;
/** Resample spacing along the path (metres); ghosts are ~20 Hz, a few metres apart. */
const STEP = 3;

/**
 * Draws each layer's ghost driving path (a map's validation ghost or a TMX
 * replay) as a tube under that layer's group, so it follows the layer
 * transform like every placement. Green at the start, red at the finish;
 * depth-tested so it threads behind and through the track like spaghetti.
 * Only the pieces that reached the next checkpoint are the line; tries that
 * ended in a respawn (core/ghostRuns) are drawn on request: thinner, in a
 * shifted hue and see-through, as ONE merged mesh per line however many
 * there are.
 * Unpickable. A line with "show checkpoint numbers" on also gets a tag at
 * every waypoint it passes (S, 1, 2, … F) — drawn over the map geometry at a
 * constant screen size, like the transform handles, so they can be found
 * from anywhere.
 */
export const ghostPathPlugin: EditorPlugin = {
  id: "builtin.ghostPath",
  name: "Ghost path",
  init(ctx: EditorContext): void {
    const built = new Map<string, Object3D[]>();
    const tags: Sprite[] = [];

    /**
     * Tube geometry per line, kept while the line's samples, the radius and the hue stay
     * the same: toggling a checkbox or dragging the opacity slider rebuilds nothing.
     */
    const geometries = new Map<readonly Vec3[], { radius: number; hue: string; line: BufferGeometry[]; attempts: BufferGeometry | null | undefined }>();
    const geometryOf = (ghost: GhostPath, radius: number, hue: string) => {
      let g = geometries.get(ghost.path);
      if (!g || g.radius !== radius || g.hue !== hue) {
        for (const old of g?.line ?? []) old.dispose();
        g?.attempts?.dispose();
        const color = new Color(hue), total = ghost.path.length;
        // Where the car gained speed and where the driver braked colour the tube's halves, when the line has the data.
        const effort = drivingEffort(ghost);
        const line = splitGhostRuns(ghost.path, ghost.times, ghost.checkpoints).line
          .map((run) => tubeGeometry(run.points, run.start / total, (run.start + run.points.length) / total, radius, 8, color,
            effort ? { accel: effort.accel.slice(run.start, run.start + run.points.length), brake: effort.brake.slice(run.start, run.start + run.points.length) } : undefined))
          .filter((t): t is BufferGeometry => !!t);
        g = { radius, hue, line, attempts: undefined };
        geometries.set(ghost.path, g);
      }
      return g;
    };
    /** The attempts of a line as one geometry, built the first time they are shown. */
    const attemptsOf = (ghost: GhostPath, radius: number, hue: string): BufferGeometry | null => {
      const g = geometryOf(ghost, radius, hue);
      if (g.attempts === undefined) {
        const color = attemptColor(hue), total = ghost.path.length;
        const tubes = splitGhostRuns(ghost.path, ghost.times, ghost.checkpoints).attempts
          .map((run) => tubeGeometry(run.points, run.start / total, (run.start + run.points.length) / total, radius * ATTEMPT_RADIUS, 5, color))
          .filter((t): t is BufferGeometry => !!t);
        g.attempts = tubes.length ? mergeGeometries(tubes) : null;
        for (const t of tubes) t.dispose();
      }
      return g.attempts;
    };

    const clearLayer = (layerId: string) => {
      // Tube geometry belongs to the cache above; only the meshes and their materials go.
      for (const o of built.get(layerId) ?? []) {
        o.removeFromParent();
        if (o.name === "ghost-marker") (o as Mesh).geometry.dispose();
        ((o as Mesh).material as MeshLambertMaterial | undefined)?.dispose();
      }
      built.delete(layerId);
    };

    /** Lines the playback bar has taken out of view for now ("<layerId>\n<key>"). */
    const playbackHidden = new Set<string>();
    const applyPlaybackHidden = () => {
      for (const objs of built.values())
        for (const o of objs) if (o.userData.line) o.visible = !playbackHidden.has(o.userData.line as string);
    };
    ctx.events.on("linePlaybackHidden", ({ layerId, key, hidden }) => {
      const id = `${layerId}\n${key}`;
      if (hidden) playbackHidden.add(id); else playbackHidden.delete(id);
      applyPlaybackHidden();
    });

    const clearTags = () => {
      for (const t of tags) {
        t.removeFromParent();
        t.material.map?.dispose();
        t.material.dispose();
      }
      tags.length = 0;
    };

    /** The checkpoint tags alone: cheap, and the only thing waypoint changes touch (tubes are not). */
    const rebuildTags = () => {
      clearTags();
      for (const layer of ctx.document.layers)
        layer.ghosts.forEach((ghost, gi) => {
          if (!ghost.showNumbers || ghost.path.length < 2 || ghost.visible === false || !layer.visible) return;
          for (const pass of passesOf(ctx, layer, ghost)) {
            // Passes are world metres: the tags live in the scene, not the layer group.
            const tag = numberTag(pass.number === null ? pass.label[0] : String(pass.number), lineHue(gi));
            tag.position.set(pass.pos[0], pass.pos[1] + NUMBER_LIFT, pass.pos[2]);
            ctx.view.scene.add(tag);
            tags.push(tag);
          }
        });
    };

    const rebuild = () => {
      for (const id of [...built.keys()]) clearLayer(id);
      // Free the tubes of lines that were unloaded.
      const live = new Set(ctx.document.layers.flatMap((l) => l.ghosts.map((g) => g.path as readonly Vec3[])));
      for (const [path, g] of geometries) {
        if (live.has(path)) continue;
        for (const t of g.line) t.dispose();
        g.attempts?.dispose();
        geometries.delete(path);
      }
      rebuildTags();
      const radius = ctx.view.getRenderPrefs().ghostRadius || DEFAULT_RADIUS;
      for (const layer of ctx.document.layers) {
        const group = ctx.renderer.getLayerGroup(layer.id);
        if (!group) continue;
        const objs: Object3D[] = [];
        layer.ghosts.forEach((ghost, gi) => {
          if (ghost.path.length < 2 || ghost.visible === false || !layer.visible) return;
          const first = objs.length;
          const total = ghost.path.length;
          const hue = lineHue(gi);
          for (const geom of geometryOf(ghost, radius, hue).line) {
            const tube = new Mesh(geom, new MeshLambertMaterial({ vertexColors: true }));
            tube.name = "ghost-tube";
            objs.push(tube);
          }
          const attempts = ghost.showAttempts ? attemptsOf(ghost, radius, hue) : null;
          if (attempts) {
            const opacity = Math.min(1, Math.max(0.05, ghost.attemptOpacity ?? DEFAULT_ATTEMPT_OPACITY));
            // depthWrite off: overlapping see-through tries must not punch holes in each other.
            const mesh = new Mesh(attempts, new MeshLambertMaterial({ vertexColors: true, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
            mesh.name = "ghost-attempts";
            mesh.userData.line = `${layer.id}\n${ghost.key}`;
            mesh.renderOrder = 2;
            objs.push(mesh);
          }
          objs.push(marker(ghost.path[0], START, radius), marker(ghost.path[total - 1], END, radius));
          // Everything of this line answers to one name (playback hides it, the opacity slider finds it).
          for (const o of objs.slice(first)) o.userData.line = `${layer.id}\n${ghost.key}`;
        });
        for (const o of objs) {
          o.raycast = () => {};
          group.add(o);
        }
        if (objs.length) built.set(layer.id, objs);
      }
      applyPlaybackHidden();
    };

    // Dragging the opacity slider restyles the one mesh; the document changes on release.
    ctx.events.on("attemptOpacityPreview", ({ layerId, key, opacity }) => {
      for (const o of built.get(layerId) ?? []) {
        if (o.name !== "ghost-attempts" || o.userData.line !== `${layerId}\n${key}`) continue;
        const m = (o as Mesh).material as MeshLambertMaterial;
        m.opacity = opacity;
        m.transparent = opacity < 1;
        m.depthWrite = opacity >= 1;
        m.needsUpdate = true;
      }
    });
    ctx.document.events.on("reset", rebuild);
    ctx.document.events.on("layerAdded", rebuild);
    ctx.document.events.on("layerRemoved", rebuild);
    ctx.document.events.on("layerChanged", rebuild);
    // The numbers depend on the waypoints: follow map edits and late-loading item meshes.
    onPassesChanged(ctx, rebuildTags);
    ctx.view.onRenderPrefsChanged(rebuild);
    rebuild();
  },
};

/** Attempts are drawn thinner than the line, */
const ATTEMPT_RADIUS = 0.7;
/** and in a neighbouring, paler hue, so they read as "the same driver, but not the line". */
function attemptColor(hue: string): Color {
  const hsl = { h: 0, s: 0, l: 0 };
  new Color(hue).getHSL(hsl);
  return new Color().setHSL((hsl.h + 0.08) % 1, hsl.s * 0.6, Math.min(0.78, hsl.l + 0.12));
}

/** The tube's left half goes this colour where the car gains speed hard, its right half this under full brake. */
const THROTTLE = new Color(0x7dff4a);
const BRAKE = new Color(0xff3232);
/** Gaining this much speed (km/h per second) colours the left half fully; a Stadium car off the line manages ~25. */
const FULL_ACCEL = 18;

/**
 * Per sample, 0..1: how hard the car is GAINING speed, and how hard the brake is down. The gas
 * itself is no use — it is held nearly the whole run — so acceleration comes from the recorded
 * speed (smoothed over a few samples), braking from the pedal.
 */
function drivingEffort(ghost: GhostPath): { accel: number[]; brake: number[] } | null {
  const n = ghost.path.length;
  if (ghost.speed?.length !== n || ghost.brake?.length !== n) return null;
  const time = (i: number) => (ghost.times?.length === n ? ghost.times[i] : i * 50);
  const accel = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    const dt = (time(b) - time(a)) / 1000;
    const rate = dt > 0 ? (ghost.speed[b] - ghost.speed[a]) / dt : 0;
    accel[i] = Math.min(1, Math.max(0, rate / FULL_ACCEL));
  }
  return { accel, brake: ghost.brake.map((v) => Math.min(1, Math.max(0, v / 100))) };
}

/**
 * One run as a smooth tube in the given hue, bright at the start of the ghost and darkening
 * toward its end. The tube is built about a frame that keeps the world's up (a loop or a wall
 * ride carries it round smoothly), so its halves are the car's own left and right — and with
 * `effort`, the LEFT half turns THROTTLE-green along the stretches where the car gained speed
 * (by how hard), the RIGHT half BRAKE-red where the brake was down; everywhere else both halves
 * stay the line's colour. The seam between the halves is crisp (its vertices are doubled).
 */
function tubeGeometry(
  run: Vec3[], t0: number, t1: number, radius: number, sides: number, base: Color,
  effort?: { accel: number[]; brake: number[] },
): BufferGeometry | null {
  const pts = run.map(([x, y, z]) => new Vector3(x, y, z));
  const curve = new CatmullRomCurve3(pts, false, "centripetal");
  const length = curve.getLength();
  if (length < 1) return null;
  const segments = Math.max(4, Math.min(4000, Math.round(length / STEP)));
  const half = Math.max(2, Math.ceil(sides / 2));
  const ring = 2 * (half + 1); // each half's strip has its own seam vertices
  const rings = segments + 1;
  const position = new Float32Array(rings * ring * 3);
  const normal = new Float32Array(rings * ring * 3);
  const colors = new Float32Array(rings * ring * 3);
  const dark = base.clone().multiplyScalar(0.35);
  const c = new Color(), shade = new Color();
  // Which sample each ring is nearest, by arc length along the samples, for the inputs.
  const arc = [0];
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  let sample = 0;
  const up = new Vector3(0, 1, 0), T = new Vector3(), S = new Vector3(), N = new Vector3(), P = new Vector3(), R = new Vector3();
  const prevS = new Vector3(1, 0, 0);
  for (let r = 0; r < rings; r++) {
    const u = r / segments;
    curve.getPointAt(u, P);
    curve.getTangentAt(u, T);
    // Side = up x forward: the car's left when the line runs level; through a loop the previous
    // side carries over (projected off the tangent) so the halves do not flip.
    S.crossVectors(up, T);
    // The first ring sets the side (whichever way the run heads); later rings may not flip it.
    if (S.lengthSq() < 1e-4 || (r > 0 && S.dot(prevS) < 0)) S.copy(prevS).addScaledVector(T, -prevS.dot(T));
    if (S.lengthSq() < 1e-8) S.copy(prevS);
    S.normalize();
    prevS.copy(S);
    N.crossVectors(T, S).normalize();
    const along = u * length;
    while (sample + 1 < arc.length && arc[sample + 1] <= along) sample++;
    const gas = effort ? effort.accel[sample] : 0, brake = effort ? effort.brake[sample] : 0;
    shade.copy(base).lerp(dark, t0 + (t1 - t0) * u);
    for (let side = 0; side < 2; side++) {
      // Left strip: angles -90..90 about the side vector; right strip: 90..270.
      for (let j = 0; j <= half; j++) {
        const angle = (side === 0 ? -Math.PI / 2 : Math.PI / 2) + (Math.PI * j) / half;
        R.copy(S).multiplyScalar(Math.cos(angle)).addScaledVector(N, Math.sin(angle));
        const k = (r * ring + side * (half + 1) + j) * 3;
        position[k] = P.x + R.x * radius; position[k + 1] = P.y + R.y * radius; position[k + 2] = P.z + R.z * radius;
        normal[k] = R.x; normal[k + 1] = R.y; normal[k + 2] = R.z;
        c.copy(shade);
        if (side === 0 && gas > 0) c.lerp(THROTTLE, gas);
        if (side === 1 && brake > 0) c.lerp(BRAKE, brake);
        colors[k] = c.r; colors[k + 1] = c.g; colors[k + 2] = c.b;
      }
    }
  }
  const index: number[] = [];
  for (let r = 0; r < segments; r++) {
    for (let side = 0; side < 2; side++) {
      for (let j = 0; j < half; j++) {
        const a = r * ring + side * (half + 1) + j, b = a + 1, d = a + ring, e = b + ring;
        index.push(a, b, d, b, e, d); // counter-clockwise seen from outside
      }
    }
  }
  const geom = new BufferGeometry();
  geom.setAttribute("position", new Float32BufferAttribute(position, 3));
  geom.setAttribute("normal", new Float32BufferAttribute(normal, 3));
  geom.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geom.setIndex(index);
  return geom;
}

/** A checkpoint number: a pill in the line's hue, always on top, the same size at any distance. */
function numberTag(text: string, hue: string): Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const c = canvas.getContext("2d")!;
  c.fillStyle = hue;
  c.strokeStyle = "#0a0e11";
  c.lineWidth = 6;
  c.beginPath();
  c.roundRect(4, 4, 120, 56, 28);
  c.fill();
  c.stroke();
  c.fillStyle = "#0a0e11";
  c.font = "bold 40px sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(text, 64, 34);
  const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), depthTest: false, depthWrite: false, fog: false, sizeAttenuation: false, transparent: true }));
  sprite.scale.set(0.07, 0.035, 1);
  sprite.renderOrder = 998;
  sprite.raycast = () => {};
  sprite.name = "ghost-number";
  return sprite;
}

function marker(p: Vec3, color: Color, radius: number): Mesh {
  const m = new Mesh(new SphereGeometry(radius * 2, 12, 10), new MeshLambertMaterial({ color }));
  m.position.set(p[0], p[1], p[2]);
  m.name = "ghost-marker";
  return m;
}
