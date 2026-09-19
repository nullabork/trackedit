/**
 * Waypoints (start, checkpoints, finish) and the order a driving line passes
 * through them. Pure math: every waypoint is an oriented box in world metres,
 * the line is tested segment by segment against it.
 *
 * What IS a waypoint comes from the game's own block/item definitions
 * (`meshdump waypoints` -> waypoints.json), or from the waypoint data an
 * imported placement carries — never from a block's name
 * ("DecoPlatformDirtSlope2Start" is a slope).
 */
import type { Layer, Placement } from "./layer";
import type { GridCoord, Quat, Vec3 } from "./math";
import { CELL, degToRad, quatFromAxisAngle, quatFromEulerYXZ, quatFromGameRot, quatMul, quatRotate } from "./math";

export type WaypointKind = "start" | "checkpoint" | "finish" | "multilap";

/** A definition's type (Start / Finish / Checkpoint / StartFinish) or a map tag (Spawn / Goal / LinkedCheckpoint …). */
export function waypointKind(type: string | null | undefined): WaypointKind | null {
  switch (type) {
    case "Start":
    case "Spawn":
      return "start";
    case "Finish":
    case "Goal":
      return "finish";
    case "Checkpoint":
    case "LinkedCheckpoint":
      return "checkpoint";
    case "StartFinish":
      return "multilap";
    default:
      return null;
  }
}

/** The tag the game stores on a placed waypoint of this definition type. */
export function waypointTagFor(type: string): string | null {
  return ({ Start: "Spawn", Finish: "Goal", Checkpoint: "Checkpoint", StartFinish: "StartFinish" } as Record<string, string>)[type] ?? null;
}

/** Definition types by block/item name, with items also found by their file name alone. */
export class WaypointTypes {
  private readonly byName = new Map<string, string>();

  constructor(json: Record<string, string> = {}) {
    for (const [name, type] of Object.entries(json)) {
      this.byName.set(name.toLowerCase(), type);
      const base = name.split(/[\\/]/).pop()!;
      if (!this.byName.has(base.toLowerCase())) this.byName.set(base.toLowerCase(), type);
    }
  }

  typeOf(block: string): string | null {
    const key = block.toLowerCase();
    return this.byName.get(key) ?? this.byName.get(key.split(/[\\/]/).pop()!) ?? null;
  }

  /** What a placement is: its own imported waypoint data first, else its definition. */
  kindOf(p: Placement): WaypointKind | null {
    const meta = p.meta as { waypoint?: { tag?: string } | string | null } | undefined;
    if (meta && "waypoint" in meta && meta.waypoint) {
      const tag = typeof meta.waypoint === "string" ? meta.waypoint : meta.waypoint.tag;
      const kind = waypointKind(tag);
      if (kind) return kind;
    }
    return waypointKind(this.typeOf(p.block));
  }
}

/** An oriented box: `half` extents along the axes of `quat`, around `centre` (world metres). */
export interface WaypointVolume {
  placementId: string;
  layerId: string;
  block: string;
  kind: WaypointKind;
  centre: Vec3;
  half: Vec3;
  quat: Quat;
  /** Linked checkpoints share one: taking any of them takes them all. */
  link?: string;
}

/** Slack around a waypoint's box: cars clip corners and fly over low road checkpoints. */
export const WAYPOINT_MARGIN: Vec3 = [3, 6, 3];
/** An item whose model is not known yet: a gate-sized box above its anchor. */
const ITEM_HALF: Vec3 = [16, 10, 16];

/** A model's own bounding box, in model space (before the pivot). */
export interface ModelBounds {
  min: Vec3;
  max: Vec3;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function layerFrame(layer: Pick<Layer, "transform">): { q: Quat; t: Vec3 } {
  const r = layer.transform.rotDeg;
  return { q: quatFromEulerYXZ([degToRad(r[0]), degToRad(r[1]), degToRad(r[2])]), t: layer.transform.translate };
}

/** Layer-local points (placements, driving lines) in world metres. */
export function toWorld(layer: Pick<Layer, "transform">, points: readonly Vec3[]): Vec3[] {
  const { q, t } = layerFrame(layer);
  return points.map((p) => add(quatRotate(q, p), t));
}

/** Every visible layer's waypoints as world-space boxes. */
export function waypointVolumes(
  layers: readonly Layer[],
  types: WaypointTypes,
  sizeOf: (block: string) => GridCoord | undefined,
  /** Items have no grid size: their real model bounds, when the caller has the mesh. */
  boundsOf?: (block: string) => ModelBounds | undefined,
): WaypointVolume[] {
  const out: WaypointVolume[] = [];
  for (const layer of layers) {
    if (!layer.visible) continue;
    const frame = layerFrame(layer);
    for (const p of layer.placements.values()) {
      const kind = types.kindOf(p);
      if (!kind) continue;
      const size = sizeOf(p.block) ?? [1, 1, 1];
      const blockHalf: Vec3 = [(size[0] * CELL[0]) / 2, (size[1] * CELL[1]) / 2, (size[2] * CELL[2]) / 2];
      let centre: Vec3, half: Vec3, quat: Quat;
      if (p.kind === "block") {
        // Same footprint maths as the renderer: quarter turns swap x and z.
        const rotated = p.dir % 2 === 1;
        const ex = rotated ? blockHalf[2] : blockHalf[0], ez = rotated ? blockHalf[0] : blockHalf[2];
        centre = [p.coord[0] * CELL[0] + ex, p.coord[1] * CELL[1] + blockHalf[1], p.coord[2] * CELL[2] + ez];
        half = blockHalf;
        quat = quatFromAxisAngle([0, 1, 0], -p.dir * (Math.PI / 2));
      } else {
        quat = quatFromGameRot(p.rot);
        // A free block's position is its min corner; an item's model sits at its anchor plus its pivot.
        let local: Vec3 = blockHalf;
        half = blockHalf;
        if (p.isItem) {
          const b = boundsOf?.(p.block);
          half = b ? [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2] : ITEM_HALF;
          const mid: Vec3 = b ? [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2] : [0, ITEM_HALF[1] - 2, 0];
          local = add(p.pivot ?? [0, 0, 0], mid);
        }
        centre = add(p.pos, quatRotate(quat, local));
      }
      const wp = (p.meta as { waypoint?: { tag?: string; order?: number } | null } | undefined)?.waypoint;
      out.push({
        ...(wp?.tag === "LinkedCheckpoint" ? { link: `linked:${wp.order ?? 0}` } : {}),
        placementId: p.id, layerId: layer.id, block: p.block, kind,
        centre: add(quatRotate(frame.q, centre), frame.t),
        half: add(half, WAYPOINT_MARGIN),
        quat: quatMul(frame.q, quat),
      });
    }
  }
  return out;
}

/** One pass of a line through a waypoint. */
export interface WaypointPass {
  placementId: string;
  layerId: string;
  block: string;
  kind: WaypointKind;
  /** "Start", "CP 3", "Lap 1", "Finish". */
  label: string;
  /** Running checkpoint count (checkpoints and laps), null for start and finish. */
  number: number | null;
  /** Index of the sample nearest the waypoint's centre during the pass. */
  index: number;
  /** That sample, world metres. */
  pos: Vec3;
  timeMs?: number;
}

/** Distance from a point to an oriented box (0 inside). */
function distanceToVolume(p: Vec3, v: WaypointVolume): number {
  const l = quatRotate(conj(v.quat), [p[0] - v.centre[0], p[1] - v.centre[1], p[2] - v.centre[2]]);
  return Math.hypot(Math.max(Math.abs(l[0]) - v.half[0], 0), Math.max(Math.abs(l[1]) - v.half[1], 0), Math.max(Math.abs(l[2]) - v.half[2], 0));
}

function nearest(p: Vec3, volumes: readonly WaypointVolume[], accept: (v: WaypointVolume) => boolean): WaypointVolume | null {
  let best: WaypointVolume | null = null;
  let bestDist = Infinity;
  for (const v of volumes) {
    if (!accept(v)) continue;
    const d = distanceToVolume(p, v);
    if (d < bestDist) { best = v; bestDist = d; }
  }
  return best;
}

/** Index of the sample at (or just after) a race time. */
function sampleAt(times: readonly number[], ms: number): number {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The exact version: the ghost recorded WHEN it took every checkpoint (the
 * finish last), so the count and order are the game's own. Each time gives a
 * point on the line, and the waypoint nearest that point is the one taken —
 * which also picks the right one of a linked pair. Trigger zones are often
 * bigger than the models (gates, custom platforms), so nearest, not inside.
 */
export function passesFromCheckpointTimes(
  path: readonly Vec3[],
  times: readonly number[],
  checkpoints: readonly number[],
  volumes: readonly WaypointVolume[],
): WaypointPass[] {
  const out: WaypointPass[] = [];
  const push = (v: WaypointVolume, label: string, number: number | null, index: number, timeMs: number) =>
    out.push({ placementId: v.placementId, layerId: v.layerId, block: v.block, kind: v.kind, label, number, index, pos: path[index], timeMs });
  const start = nearest(path[0], volumes, (v) => v.kind === "start" || v.kind === "multilap");
  if (start) push(start, "Start", null, 0, 0);
  checkpoints.forEach((ms, n) => {
    const index = sampleAt(times, ms);
    const last = n === checkpoints.length - 1;
    const v = last
      ? nearest(path[index], volumes, (c) => c.kind === "finish" || c.kind === "multilap")
      : nearest(path[index], volumes, (c) => c.kind === "checkpoint" || c.kind === "multilap");
    if (!v) return;
    if (last) push(v, "Finish", null, index, ms);
    else push(v, v.kind === "multilap" ? `Lap ${n + 1}` : `CP ${n + 1}`, n + 1, index, ms);
  });
  return out;
}

/** A jump this long between samples is a respawn, not driving. */
const TELEPORT = 40;

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Does the segment a-b (box-local) touch the box |x| <= half? */
function segmentHitsBox(a: Vec3, b: Vec3, half: Vec3): boolean {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(a[i]) > half[i]) return false;
      continue;
    }
    let lo = (-half[i] - a[i]) / d, hi = (half[i] - a[i]) / d;
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The waypoints a line passes through, in driving order, counted the way the
 * game counts them: a checkpoint is taken once per lap (driving through it
 * again, or respawning onto it, changes nothing; a multilap line resets them),
 * and linked checkpoints are one checkpoint.
 *
 * `finished`: the line is a completed run (every record and validation ghost
 * is), so its last sample IS the finish even when the finish trigger is
 * bigger than the box we know — custom finish items can be huge and
 * invisible. The nearest finish then takes the line's end.
 */
export function linePasses(
  path: readonly Vec3[],
  volumes: readonly WaypointVolume[],
  times?: readonly number[],
  finished = false,
): WaypointPass[] {
  interface Open { start: number; best: number; bestDist: number; counted: boolean }
  const found: Array<{ v: WaypointVolume; start: number; best: number }> = [];
  volumes.forEach((v) => {
    const inv = conj(v.quat);
    const local = (p: Vec3): Vec3 => quatRotate(inv, [p[0] - v.centre[0], p[1] - v.centre[1], p[2] - v.centre[2]]);
    let open: Open | null = null;
    let prev: Vec3 | null = null;
    for (let i = 0; i < path.length; i++) {
      const cur = local(path[i]);
      const jumped = i > 0 && Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]) > TELEPORT;
      const inside = Math.abs(cur[0]) <= v.half[0] && Math.abs(cur[1]) <= v.half[1] && Math.abs(cur[2]) <= v.half[2];
      const touched = inside || (!jumped && prev !== null && segmentHitsBox(prev, cur, v.half));
      if (touched) {
        const dist = Math.hypot(cur[0], cur[1], cur[2]);
        if (!open) open = { start: i, best: i, bestDist: dist, counted: !(jumped && inside) };
        else if (dist < open.bestDist) { open.best = i; open.bestDist = dist; }
      }
      if (open && (!inside || i === path.length - 1)) {
        if (open.counted) found.push({ v, start: open.start, best: open.best });
        open = null;
      }
      prev = cur;
    }
  });
  found.sort((a, b) => a.start - b.start);

  // Once per lap, as the game counts.
  const taken = new Set<string>();
  const counted = found.filter((f) => {
    if (f.v.kind === "multilap") taken.clear();
    if (f.v.kind !== "checkpoint") return true;
    const key = f.v.link ?? f.v.placementId;
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
  found.length = 0;
  found.push(...counted);

  if (finished && path.length > 1) {
    const last = found[found.length - 1];
    const ends = last && (last.v.kind === "finish" || (last.v.kind === "multilap" && found.length > 1));
    if (!ends) {
      const end = path[path.length - 1];
      let nearest: WaypointVolume | null = null;
      let nearestDist = Infinity;
      for (const v of volumes) {
        if (v.kind !== "finish" && v.kind !== "multilap") continue;
        const d = Math.hypot(end[0] - v.centre[0], end[1] - v.centre[1], end[2] - v.centre[2]);
        if (d < nearestDist) { nearest = v; nearestDist = d; }
      }
      if (nearest) found.push({ v: nearest, start: path.length - 1, best: path.length - 1 });
    }
  }

  let count = 0;
  const lastLap = found.map((f) => f.v.kind).lastIndexOf("multilap");
  return found.map((f, n) => {
    const { v } = f;
    let label: string, number: number | null = null;
    if (v.kind === "start" || (v.kind === "multilap" && n === 0)) label = "Start";
    else if (v.kind === "finish" || (v.kind === "multilap" && n === lastLap && n === found.length - 1)) label = "Finish";
    else {
      number = ++count;
      label = v.kind === "multilap" ? `Lap ${number}` : `CP ${number}`;
    }
    return {
      placementId: v.placementId, layerId: v.layerId, block: v.block, kind: v.kind, label, number,
      index: f.best, pos: path[f.best], ...(times?.[f.best] !== undefined ? { timeMs: times[f.best] } : {}),
    };
  });
}
