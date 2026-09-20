import { CELL } from "@core/math";
import type { Dir, GridCoord } from "@core/math";

/**
 * Which of a grid block's clip caps to hide because a neighbour joins them.
 *
 * Every unit face of a block can carry clips: caps the game shows only while
 * that side is open (platform edge trims, the "turbines" on the ends of
 * special platforms, deco walls, base undersides). When the block next
 * door carries a clip of the same clip group on its facing side, the two
 * connect and both caps vanish, so the surfaces tile. Maps store nothing
 * about this — the game derives it from neighbours, and so do we.
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
  group?: string;
  /** The group this clip joins with, when different from its own. */
  sym?: string;
  vertical?: boolean;
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

/** Two facing clips join when they share a clip group (or one names the other's). */
export function clipsConnect(a: UnitClip, b: UnitClip): boolean {
  if (a.id === b.id) return true;
  if (a.group && (a.group === b.group || a.group === b.sym)) return true;
  if (a.sym && a.sym === b.group) return true;
  return false;
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
      // Top and bottom caps are the game's "FreeClipTop" / "FreeClipBottom": they
      // exist on a FREE face only. Whatever occupies the cell above or below —
      // a snow hill over a deco-wall slope has no clip of its own at all —
      // the cap is gone. Side clips still need a partner that joins them.
      const cap = clip.face === "top" || clip.face === "bottom";
      const joins = cap || other.info.clips.some((d) =>
        d.face === face && d.u[0] === unit[0] && d.u[1] === unit[1] && d.u[2] === unit[2] && clipsConnect(clip, d));
      if (joins) {
        hidden.add(clipPartName(clip));
        break;
      }
    }
  }
  return hidden;
}
