import { CELL } from "@core/math";
import type { Dir, GridCoord } from "@core/math";

/**
 * Which of a grid block's clip caps to hide because a neighbour joins them.
 *
 * Every unit face of a block can carry clips: caps the game shows only while
 * that side is open (platform edge trims, the "turbines" on the ends of
 * special platforms, deco walls, base undersides). The rule is the game's
 * own, read from its clip definitions (clipdefs.json, see `ClipDef`): a clip
 * vanishes when the clip facing it MATES with it, or when it can be deleted
 * by a full free clip and the one facing it is one. Nothing else hides a
 * clip — not a block that merely stands in the faced cell, not one that
 * overlaps the clip's own cell, and ghost blocks count like any other.
 *
 * Verified, not assumed: the game bakes the clip blocks it generated into
 * every map file, and `npm run cliptruth` compares ours with them clip by
 * clip (99.8% on a 24,500-block map; the older group-and-overlap heuristics
 * reached 93.5%).
 *
 * Geometry comes from meshdump with each clip as its own OBJ group named
 * `clip:<id>:<face>:<x,y,z>`; index.json lists the units and clips per
 * variant. This module is pure so the rule can be tested without a scene.
 */

export type ClipFace = "north" | "south" | "east" | "west" | "top" | "bottom";

export interface UnitClip {
  /** Unit offset within the block, in cells. */
  u: [number, number, number];
  face: ClipFace;
  id: string;
  vertical?: boolean;
  /** From the clip's definition — see `ClipDef`; filled in by `withClipDefs`. */
  group?: string;
  sym?: string;
  asym?: string;
  full?: boolean;
  deletable?: boolean;
  vgroup?: string;
}

/** A clip definition's rule fields (meshdump writes them to clipdefs.json). */
export interface ClipDef {
  /** ClipGroupId: clips of one group mate with each other. */
  group?: string;
  /** SymmetricalClipGroupId: mates with clips of THAT group instead (top plate <-> underside). */
  sym?: string;
  /** ASymmetricalClipId: mates with exactly that clip (a Left panel with its Right). */
  asym?: string;
  /** IsFullFreeClip: covers its whole face — deletes a deletable clip facing it. */
  full?: boolean;
  /** CanBeDeletedByFullFreeClip. */
  deletable?: boolean;
  /** VerticalClipGroupId: wall panels of one group stack into one wall (see `wallSegments`). */
  vgroup?: string;
}
export type ClipDefs = Record<string, ClipDef | undefined>;

/**
 * Clips with their definitions' rule fields. index.json's own `group`/`sym`
 * (an extractor-side guess from before the definitions were read in full)
 * are dropped, never mixed in.
 */
export function withClipDefs(clips: readonly UnitClip[], defs: ClipDefs): UnitClip[] {
  return clips.map(({ u, face, id, vertical }) => ({ u, face, id, vertical, ...defs[id] }));
}

export interface BlockClipInfo {
  /** Footprint in cells (the renderer's pivot depends on it). */
  size: [number, number, number];
  units: [number, number, number][];
  clips: UnitClip[];
}

export interface GridPose {
  coord: GridCoord;
  dir: Dir;
}

export interface ClipSubject {
  pose: GridPose;
  info: BlockClipInfo;
}

/** Block-local outward normals. East is the x=0 face, west x=32 (GBX). */
export const FACE_NORMAL: Record<ClipFace, [number, number, number]> = {
  north: [0, 0, 1],
  south: [0, 0, -1],
  east: [-1, 0, 0],
  west: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

/** Rotate a block-local vector by the placement's `dir` (yaw -dir·90° about Y, as the renderer does). */
export function rotateByDir(v: readonly [number, number, number], dir: Dir): [number, number, number] {
  let [x, z] = [v[0], v[2]];
  for (let i = 0; i < dir; i++) [x, z] = [-z, x];
  return [x + 0, v[1], z + 0];
}

/** Inverse of rotateByDir. */
export function unrotateByDir(v: readonly [number, number, number], dir: Dir): [number, number, number] {
  let [x, z] = [v[0], v[2]];
  for (let i = 0; i < dir; i++) [x, z] = [z, -x];
  return [x + 0, v[1], z + 0];
}

/** The layer-local cell a unit of a placed block occupies. */
export function unitCell(pose: GridPose, size: [number, number, number], unit: readonly [number, number, number]): GridCoord {
  // Same transform as DocumentRenderer.buildObject: the mesh is modelled
  // from its min corner, pivots about the footprint centre, and the group
  // sits at the rotated footprint's centre.
  const rotated = pose.dir % 2 === 1;
  const ex = (rotated ? size[2] : size[0]) * CELL[0];
  const ez = (rotated ? size[0] : size[2]) * CELL[2];
  const local: [number, number, number] = [
    unit[0] * CELL[0] + CELL[0] / 2 - (size[0] * CELL[0]) / 2,
    unit[1] * CELL[1] + CELL[1] / 2,
    unit[2] * CELL[2] + CELL[2] / 2 - (size[2] * CELL[2]) / 2,
  ];
  const r = rotateByDir(local, pose.dir);
  const wx = pose.coord[0] * CELL[0] + ex / 2 + r[0];
  const wy = pose.coord[1] * CELL[1] + r[1];
  const wz = pose.coord[2] * CELL[2] + ez / 2 + r[2];
  return [Math.floor(wx / CELL[0]), Math.floor(wy / CELL[1]), Math.floor(wz / CELL[2])];
}

/** Every cell a placed block occupies. */
export function occupiedCells(subject: ClipSubject): GridCoord[] {
  const units = subject.info.units.length ? subject.info.units : [[0, 0, 0] as [number, number, number]];
  return units.map((u) => unitCell(subject.pose, subject.info.size, u));
}

export const cellKey = (c: readonly number[]): string => `${c[0]},${c[1]},${c[2]}`;

/** Which block-local face of a placed block looks along a layer-local direction. */
export function faceToward(worldNormal: readonly [number, number, number], dir: Dir): ClipFace | null {
  const [x, y, z] = unrotateByDir(worldNormal, dir);
  for (const [face, n] of Object.entries(FACE_NORMAL) as [ClipFace, [number, number, number]][])
    if (n[0] === x && n[1] === y && n[2] === z) return face;
  return null;
}

/**
 * Does clip `a` mate with the clip `b` facing it? By `a`'s definition: a named
 * partner clip, or a partner group; without either, its own group, or — with
 * no group at all — the same clip. One-directional on purpose: measured
 * against the game's baked clips, asking `b` to agree as well (or instead)
 * is worse.
 */
export function clipsConnect(a: UnitClip, b: UnitClip): boolean {
  if (a.asym && b.id === a.asym) return true;
  if (a.sym && b.group === a.sym) return true;
  if (a.sym || a.asym) return false;
  return a.group ? b.group === a.group : a.id === b.id;
}

/** Is clip `a` gone because of the clip `b` facing it? */
export function clipHiddenBy(a: UnitClip, b: UnitClip): boolean {
  return clipsConnect(a, b) || (a.deletable === true && b.full === true);
}

/** OBJ group name meshdump gives a clip's geometry. */
export const clipPartName = (c: UnitClip): string => `clip:${c.id}:${c.face}:${c.u[0]},${c.u[1]},${c.u[2]}`;

/**
 * Names of the clip parts a placed block must hide, given a lookup of the
 * blocks occupying any layer-local cell.
 */
export function hiddenClipParts(
  subject: ClipSubject,
  blocksAt: (cell: GridCoord) => Iterable<ClipSubject>,
): Set<string> {
  const hidden = new Set<string>();
  for (const clip of subject.info.clips) {
    const cell = unitCell(subject.pose, subject.info.size, clip.u);
    const n = rotateByDir(FACE_NORMAL[clip.face], subject.pose.dir);
    const target: GridCoord = [cell[0] + n[0], cell[1] + n[1], cell[2] + n[2]];
    const back: [number, number, number] = [-n[0], -n[1], -n[2]];
    for (const other of blocksAt(target)) {
      const face = faceToward(back, other.pose.dir);
      if (!face) continue;
      const unit = (other.info.units.length ? other.info.units : [[0, 0, 0] as [number, number, number]])
        .find((u) => cellKey(unitCell(other.pose, other.info.size, u)) === cellKey(target));
      if (!unit) continue;
      const joins = other.info.clips.some((d) =>
        d.face === face && d.u[0] === unit[0] && d.u[1] === unit[1] && d.u[2] === unit[2] && clipHiddenBy(clip, d));
      if (joins) {
        hidden.add(clipPartName(clip));
        break;
      }
    }
  }
  return hidden;
}

/**
 * Which SEGMENT each shown wall panel of a block is: a vertical clip's mesh comes as
 * Middle / Top / Bottom / TopBottom (row 0..3 of its mobil table), and the game picks by
 * whether a shown panel of the same vertical group continues the wall directly above and
 * directly below — in this block or in another one. Returned per clip part name as
 * `{ above, below }`; 92.7% of RHEVARA's 9,517 baked wall panels carry the variant this
 * predicts (always-TopBottom, the old per-block answer for single-cell blocks, 27%).
 *
 * `hiddenOf` must answer for ANY subject (the caller caches it): a panel that is hidden
 * does not continue a wall.
 */
export function wallSegments(
  subject: ClipSubject,
  blocksAt: (cell: GridCoord) => Iterable<ClipSubject>,
  hiddenOf: (s: ClipSubject) => ReadonlySet<string>,
): Map<string, { above: boolean; below: boolean }> {
  const out = new Map<string, { above: boolean; below: boolean }>();
  const mine = hiddenOf(subject);
  for (const clip of subject.info.clips) {
    if (!clip.vgroup || clip.face === "top" || clip.face === "bottom" || mine.has(clipPartName(clip))) continue;
    const cell = unitCell(subject.pose, subject.info.size, clip.u);
    const n = rotateByDir(FACE_NORMAL[clip.face], subject.pose.dir);
    const continues = (dy: number): boolean => {
      const at: GridCoord = [cell[0], cell[1] + dy, cell[2]];
      for (const other of [subject, ...blocksAt(at)]) {
        const face = faceToward(n, other.pose.dir);
        if (!face) continue;
        const gone = other === subject ? mine : hiddenOf(other);
        for (const d of other.info.clips) {
          if (d.face !== face || d.vgroup !== clip.vgroup || gone.has(clipPartName(d))) continue;
          if (cellKey(unitCell(other.pose, other.info.size, d.u)) === cellKey(at)) return true;
        }
      }
      return false;
    };
    out.set(clipPartName(clip), { above: continues(1), below: continues(-1) });
  }
  return out;
}
