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
  TubeGeometry,
  Vector3,
} from "three";
import type { Object3D } from "three";
import type { Vec3 } from "@core/math";
import { lineHue } from "@core/layer";
import type { EditorContext, EditorPlugin } from "./api";
import { onPassesChanged, passesOf } from "./linePasses";

const START = new Color(0x35d07f);
const END = new Color(0xff4d4d);
/** How far above the line a checkpoint number floats (metres). */
const NUMBER_LIFT = 6;
/** Fallback tube radius in metres (render prefs override it). */
const DEFAULT_RADIUS = 1.2;
/** A jump longer than this between samples is a respawn: break the tube. */
const RESPAWN_GAP = 40;
/** Resample spacing along the path (metres); ghosts are ~20 Hz, a few metres apart. */
const STEP = 3;

/**
 * Draws each layer's ghost driving path (a map's validation ghost or a TMX
 * replay) as a tube under that layer's group, so it follows the layer
 * transform like every placement. Green at the start, red at the finish;
 * depth-tested so it threads behind and through the track like spaghetti.
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

    const clearLayer = (layerId: string) => {
      for (const o of built.get(layerId) ?? []) {
        o.removeFromParent();
        (o as Mesh).geometry?.dispose();
      }
      built.delete(layerId);
    };

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
      rebuildTags();
      const radius = ctx.view.getRenderPrefs().ghostRadius || DEFAULT_RADIUS;
      for (const layer of ctx.document.layers) {
        const group = ctx.renderer.getLayerGroup(layer.id);
        if (!group) continue;
        const objs: Object3D[] = [];
        layer.ghosts.forEach((ghost, gi) => {
          if (ghost.path.length < 2 || ghost.visible === false || !layer.visible) return;
          const total = ghost.path.length;
          const color = new Color(lineHue(gi));
          let index = 0;
          for (const run of splitRespawns(ghost.path)) {
            const t0 = index / total;
            const t1 = (index + run.length) / total;
            index += run.length;
            const tube = buildTube(run, t0, t1, radius, color);
            if (tube) objs.push(tube);
          }
          objs.push(marker(ghost.path[0], START, radius), marker(ghost.path[total - 1], END, radius));
        });
        for (const o of objs) {
          o.raycast = () => {};
          group.add(o);
        }
        if (objs.length) built.set(layer.id, objs);
      }
    };

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

/** Continuous driving runs: a respawn teleports the car, so cut there. */
function splitRespawns(path: readonly Vec3[]): Vec3[][] {
  const runs: Vec3[][] = [[path[0]]];
  for (let i = 1; i < path.length; i++) {
    const [ax, ay, az] = path[i - 1];
    const [bx, by, bz] = path[i];
    const gap = Math.hypot(bx - ax, by - ay, bz - az);
    if (gap > RESPAWN_GAP) runs.push([path[i]]);
    else runs[runs.length - 1].push(path[i]);
  }
  return runs.filter((r) => r.length >= 2);
}

/** One run as a smooth tube in the line's hue, bright at the start and darkening toward the finish. */
function buildTube(run: Vec3[], t0: number, t1: number, radius: number, base: Color): Mesh | null {
  const pts = run.map(([x, y, z]) => new Vector3(x, y, z));
  const curve = new CatmullRomCurve3(pts, false, "centripetal");
  const length = curve.getLength();
  if (length < 1) return null;
  const segments = Math.max(4, Math.min(4000, Math.round(length / STEP)));
  const geom = new TubeGeometry(curve, segments, radius, 8, false);
  // Colour per ring: vertices come in (segments + 1) rings of 9 vertices.
  const count = geom.attributes.position.count;
  const ring = 9;
  const colors = new Float32Array(count * 3);
  const dark = base.clone().multiplyScalar(0.35);
  const c = new Color();
  for (let i = 0; i < count; i++) {
    const t = t0 + (t1 - t0) * (Math.floor(i / ring) / segments);
    c.copy(base).lerp(dark, t);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geom.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const mesh = new Mesh(geom, new MeshLambertMaterial({ vertexColors: true }));
  mesh.name = "ghost-tube";
  return mesh;
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
