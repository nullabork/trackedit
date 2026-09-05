/**
 * Import/export of the gbxdump/gbxbuild JSON format used by the companion
 * tracko toolchain. Importing that format and exporting back to it is what
 * makes edits land in a real .Map.Gbx via gbxbuild.
 */

import type { Dir, GridCoord, Vec3 } from "@core/math";
import {
  CELL,
  DEFAULT_Y_OFFSET,
  degToRad,
  eulerYXZFromQuat,
  newId,
  quatFromAxisAngle,
  quatFromEulerYXZ,
  quatMul,
  quatRotate,
} from "@core/math";
import type { Layer, Placement } from "@core/layer";
import { createLayer, isIdentityTransform } from "@core/layer";
import type { MapDocument } from "@core/document";

export interface DumpBlock {
  name: string;
  coord?: [number, number, number] | null;
  dir?: number | null;
  isGround?: boolean;
  isClip?: boolean;
  isFree?: boolean;
  absPos?: [number, number, number] | null;
  yawPitchRoll?: [number, number, number] | null;
  /** flags, variant, waypoint, color, ... — preserved verbatim. */
  [extra: string]: unknown;
}

export interface DumpItem {
  name: string;
  itemAuthor?: string;
  absPos: [number, number, number];
  yawPitchRoll?: [number, number, number] | null;
  [extra: string]: unknown;
}

export interface MapDump {
  mapName?: string;
  decoration?: string;
  /** Custom texture pack reference (attached by the TMX bridge). */
  mod?: { url?: string };
  blocks?: DumpBlock[];
  items?: DumpItem[];
}

export interface ImportStats {
  gridBlocks: number;
  freeBlocks: number;
  items: number;
  clipsSkipped: number;
}

/**
 * Grid-block vertical origin: gbxdump grid coords are offset from world metres
 * by the decoration-dependent shift (see tracko's mapgeom.py). We keep editor
 * world == grid space, so only free positions need converting.
 */
function freePosToEditor(p: [number, number, number], yOffsetCells: number): Vec3 {
  return [p[0], p[1] + yOffsetCells * CELL[1], p[2]];
}

function editorPosToFree(p: Vec3, yOffsetCells: number): [number, number, number] {
  return [p[0], p[1] - yOffsetCells * CELL[1], p[2]];
}

/** Fields importDump consumes; everything else rides along in placement.meta. */
const CONSUMED_BLOCK_FIELDS = new Set(["name", "coord", "dir", "absPos", "yawPitchRoll", "isFree", "isClip"]);
const CONSUMED_ITEM_FIELDS = new Set(["name", "absPos", "yawPitchRoll"]);

function passthrough(src: object, consumed: Set<string>): Record<string, unknown> | undefined {
  let meta: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(src)) {
    if (consumed.has(k) || v === null || v === undefined) continue;
    (meta ??= {})[k] = v;
  }
  return meta;
}

export function importDump(dump: MapDump, yOffsetCells = DEFAULT_Y_OFFSET): {
  layers: Layer[];
  stats: ImportStats;
  name?: string;
  decoration?: string;
  modUrl?: string;
} {
  const layer = createLayer("Imported");
  const stats: ImportStats = { gridBlocks: 0, freeBlocks: 0, items: 0, clipsSkipped: 0 };

  for (const b of dump.blocks ?? []) {
    if (b.isClip) {
      stats.clipsSkipped += 1;
      continue;
    }
    if (b.isFree && b.absPos) {
      layer.placements.set(...entry({
        id: newId("p"),
        kind: "free",
        block: b.name,
        pos: freePosToEditor(b.absPos, yOffsetCells),
        rot: (b.yawPitchRoll as Vec3) ?? [0, 0, 0],
        isItem: false,
        meta: passthrough(b, CONSUMED_BLOCK_FIELDS),
      }));
      stats.freeBlocks += 1;
    } else if (b.coord) {
      layer.placements.set(...entry({
        id: newId("p"),
        kind: "block",
        block: b.name,
        coord: b.coord as GridCoord,
        dir: ((b.dir ?? 0) & 3) as Dir,
        meta: passthrough(b, CONSUMED_BLOCK_FIELDS),
      }));
      stats.gridBlocks += 1;
    }
  }

  for (const it of dump.items ?? []) {
    layer.placements.set(...entry({
      id: newId("p"),
      kind: "free",
      block: it.name,
      pos: freePosToEditor(it.absPos, yOffsetCells),
      rot: (it.yawPitchRoll as Vec3) ?? [0, 0, 0],
      isItem: true,
      meta: passthrough(it, CONSUMED_ITEM_FIELDS),
    }));
    stats.items += 1;
  }

  return {
    layers: [layer],
    stats,
    name: dump.mapName,
    decoration: dump.decoration,
    modUrl: dump.mod?.url || undefined,
  };
}

function entry(p: Placement): [string, Placement] {
  return [p.id, p];
}

/**
 * Export all visible layers to gbxbuild placements JSON.
 *
 * Layers with an identity transform export blocks on the grid. A transformed
 * layer can't stay on the game grid, so its blocks are baked to free blocks
 * (absPos + yaw) instead — gbxbuild supports both.
 */
export function exportDump(doc: MapDocument, yOffsetCells = DEFAULT_Y_OFFSET): MapDump {
  const blocks: DumpBlock[] = [];
  const items: DumpItem[] = [];

  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const identity = isIdentityTransform(layer.transform);
    // Layer rotation is a full Euler YXZ (layers can tilt on any axis);
    // conventions match DocumentRenderer / three.js.
    const q = quatFromEulerYXZ([
      degToRad(layer.transform.rotDeg[0]),
      degToRad(layer.transform.rotDeg[1]),
      degToRad(layer.transform.rotDeg[2]),
    ]);
    const [tx, ty, tz] = layer.transform.translate;

    const toWorld = (p: Vec3): Vec3 => {
      const r = quatRotate(q, p);
      return [r[0] + tx, r[1] + ty, r[2] + tz];
    };
    /** Compose the layer rotation with a placement's own, back to game yaw/pitch/roll. */
    const composeRot = (rot: Vec3): Vec3 => {
      const local = quatFromEulerYXZ([rot[1], rot[0], rot[2]]);
      const e = eulerYXZFromQuat(quatMul(q, local));
      return [e[1], e[0], e[2]];
    };

    for (const p of layer.placements.values()) {
      if (p.kind === "block") {
        if (identity) {
          blocks.push({ ...p.meta, name: p.block, coord: [...p.coord], dir: p.dir });
        } else {
          // Bake to a free block. The renderer rotates blocks about their
          // footprint centre, but a free block's absPos is its min corner —
          // rotate the corner's offset from the centre along.
          const centre: Vec3 = [
            p.coord[0] * CELL[0] + CELL[0] / 2,
            p.coord[1] * CELL[1],
            p.coord[2] * CELL[2] + CELL[2] / 2,
          ];
          const dirYaw = -p.dir * (Math.PI / 2);
          const corner = quatRotate(quatFromAxisAngle([0, 1, 0], dirYaw), [-CELL[0] / 2, 0, -CELL[2] / 2]);
          const pos = toWorld([centre[0] + corner[0], centre[1] + corner[1], centre[2] + corner[2]]);
          blocks.push({
            ...p.meta,
            name: p.block,
            isFree: true,
            absPos: editorPosToFree(pos, yOffsetCells),
            yawPitchRoll: [...composeRot([dirYaw, 0, 0])] as [number, number, number],
          });
        }
      } else {
        const pos = identity ? p.pos : toWorld(p.pos);
        const rot = identity ? p.rot : composeRot(p.rot);
        const rec = {
          ...p.meta,
          name: p.block,
          absPos: editorPosToFree(pos, yOffsetCells),
          yawPitchRoll: [rot[0], rot[1], rot[2]] satisfies number[] as [number, number, number],
        };
        if (p.isItem) items.push(rec);
        else blocks.push({ ...rec, isFree: true });
      }
    }
  }

  return { mapName: doc.name, decoration: doc.decoration, blocks, items };
}
