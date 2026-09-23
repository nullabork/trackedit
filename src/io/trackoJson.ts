/**
 * Import/export of the gbxdump/gbxbuild JSON format used by the companion
 * tracko toolchain. Importing that format and exporting back to it is what
 * makes edits land in a real .Map.Gbx via gbxbuild.
 */

import { waypointTagFor, type WaypointTypes } from "@core/waypoints";
import type { Dir, GridCoord, Vec3 } from "@core/math";
import {
  CELL,
  DEFAULT_Y_OFFSET,
  degToRad,
  gameRotFromQuat,
  newId,
  quatFromAxisAngle,
  quatFromEulerYXZ,
  quatFromGameRot,
  quatMul,
  quatRotate,
} from "@core/math";
import type { GhostPath, Layer, Placement } from "@core/layer";
import { createLayer, ghostKeyOf, isIdentityTransform } from "@core/layer";
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
  /** Model origin relative to the anchor (game PivotPosition); zero for most items. */
  pivotPos?: [number, number, number] | null;
  [extra: string]: unknown;
}

/** `meshdump ghost` output: world metres, same frame as absPos. */
export interface DumpGhost {
  source?: "map" | "tmx" | "nadeo";
  nickname?: string | null;
  raceTimeMs?: number | null;
  /** TMX replay id, when the bridge fetched one. */
  replayId?: number;
  /** Nadeo account id, for a leaderboard record's ghost. */
  accountId?: string;
  path: [number, number, number][];
  times?: number[];
  /** Race time (ms) of every checkpoint the run took, the finish last. */
  checkpoints?: number[];
  /** Inputs and speed per sample (see GhostPath). */
  steer?: number[] | null;
  gas?: number[] | null;
  brake?: number[] | null;
  speed?: number[] | null;
  rot?: number[] | null;
  wheelRot?: number[] | null;
  damper?: number[] | null;
}

export interface MapDump {
  mapName?: string;
  /** The game's map identity (used for Nadeo records). */
  mapUid?: string;
  /** Block-colour palette the map picked (Classic, Stunt, Red, Orange, …). */
  colorPalette?: string;
  decoration?: string;
  /** Custom texture pack reference (attached by the TMX bridge). */
  mod?: { url?: string };
  /** The map's own validation ghost (attached by the TMX bridge). */
  ghost?: DumpGhost;
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

/** A dumped ghost as a layer ghost: lifted like every free position. */
export function ghostToLayer(g: DumpGhost, yOffsetCells = DEFAULT_Y_OFFSET): GhostPath {
  const source = g.source ?? "map";
  const who = g.nickname ? ` by ${g.nickname}` : "";
  const what = source === "tmx" ? `TMX replay${g.replayId ? ` #${g.replayId}` : ""}`
    : source === "nadeo" ? "Nadeo record"
    : "Validation ghost";
  return {
    key: ghostKeyOf({ source, replayId: g.replayId, accountId: g.accountId }),
    source,
    ...(g.replayId ? { replayId: g.replayId } : {}),
    ...(g.accountId ? { accountId: g.accountId } : {}),
    label: what + who,
    timeMs: g.raceTimeMs ?? undefined,
    path: g.path.map((p) => freePosToEditor(p, yOffsetCells)),
    ...(g.times?.length === g.path.length ? { times: [...g.times] } : {}),
    ...(g.checkpoints?.length ? { checkpoints: [...g.checkpoints] } : {}),
    ...(g.steer?.length === g.path.length && g.gas?.length === g.path.length && g.brake?.length === g.path.length
      ? { steer: [...g.steer], gas: [...g.gas], brake: [...g.brake] } : {}),
    ...(g.speed?.length === g.path.length ? { speed: [...g.speed] } : {}),
    ...(g.rot?.length === g.path.length * 4 ? { rot: [...g.rot] } : {}),
    ...(g.wheelRot?.length === g.path.length * 4 && g.damper?.length === g.path.length * 4 ? { wheelRot: [...g.wheelRot], damper: [...g.damper] } : {}),
    ...(g.nickname ? { driver: g.nickname } : {}),
  };
}

/** Fields importDump consumes; everything else rides along in placement.meta. */
const CONSUMED_BLOCK_FIELDS = new Set(["name", "coord", "dir", "absPos", "yawPitchRoll", "isFree", "isClip"]);
const CONSUMED_ITEM_FIELDS = new Set(["name", "absPos", "yawPitchRoll", "pivotPos"]);

/** A dumped pivot as a placement pivot: only when it moves the origin. */
function pivotOf(p: [number, number, number] | null | undefined): Vec3 | undefined {
  return p && (p[0] || p[1] || p[2]) ? [p[0], p[1], p[2]] : undefined;
}

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
      ...(pivotOf(it.pivotPos) ? { pivot: pivotOf(it.pivotPos) } : {}),
      isItem: true,
      meta: passthrough(it, CONSUMED_ITEM_FIELDS),
    }));
    stats.items += 1;
  }

  if (dump.ghost?.path?.length) layer.ghosts = [ghostToLayer(dump.ghost, yOffsetCells)];

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
export function exportDump(
  doc: MapDocument,
  yOffsetCells = DEFAULT_Y_OFFSET,
  waypoints?: WaypointTypes,
  /** Hidden layers are an editor view state. A real map save must not lose what they hold. */
  includeHidden = false,
): MapDump {
  const blocks: DumpBlock[] = [];
  const items: DumpItem[] = [];
  /**
   * Placements made in the editor carry no waypoint data, and a checkpoint
   * without it is plain scenery in the game: fill it in from the block's
   * definition. Imported placements keep what they came with.
   */
  const metaOf = (p: Placement): Readonly<Record<string, unknown>> | undefined => {
    if (p.meta?.waypoint) return p.meta;
    const type = waypoints?.typeOf(p.block);
    const tag = type ? waypointTagFor(type) : null;
    return tag ? { ...p.meta, waypoint: { tag, order: 0 } } : p.meta;
  };

  for (const layer of doc.layers) {
    if (!layer.visible && !includeHidden) continue;
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
    const composeRot = (rot: Vec3): Vec3 => gameRotFromQuat(quatMul(q, quatFromGameRot(rot)));

    for (const p of layer.placements.values()) {
      if (p.kind === "block") {
        if (identity) {
          blocks.push({ ...metaOf(p), name: p.block, coord: [...p.coord], dir: p.dir });
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
            ...metaOf(p),
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
          ...metaOf(p),
          name: p.block,
          absPos: editorPosToFree(pos, yOffsetCells),
          yawPitchRoll: [rot[0], rot[1], rot[2]] satisfies number[] as [number, number, number],
        };
        // The anchor (absPos) and the layer transform leave the pivot alone:
        // it is model-local, so it rides along unchanged.
        if (p.isItem) items.push({ ...rec, pivotPos: p.pivot ? [...p.pivot] as [number, number, number] : [0, 0, 0] });
        else blocks.push({ ...rec, isFree: true });
      }
    }
  }

  return { mapName: doc.name, decoration: doc.decoration, blocks, items };
}
