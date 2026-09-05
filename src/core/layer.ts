import type { Dir, GridCoord, Vec3 } from "./math";
import { CELL, degToRad, newId, quatFromEulerYXZ, quatRotate } from "./math";

/** A block snapped to the layer's own grid. */
export interface BlockPlacement {
  readonly id: string;
  readonly kind: "block";
  readonly block: string;
  /** Layer-local grid coordinate. */
  readonly coord: GridCoord;
  readonly dir: Dir;
  /**
   * Fields from the source file the editor doesn't model yet (flags, variant,
   * waypoint, color, ...). Carried through untouched so editing an imported
   * map never destroys data.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** Freely positioned object (items; future: free blocks). Layer-local metres. */
export interface FreePlacement {
  readonly id: string;
  readonly kind: "free";
  readonly block: string;
  readonly pos: Vec3;
  /** Yaw/pitch/roll in radians. */
  readonly rot: Vec3;
  /**
   * Whether this is an item (CGameCtnAnchoredObject) or a free block.
   * Recorded at creation so export doesn't have to guess from the catalog —
   * imported maps can contain custom items the catalog has never seen.
   */
  readonly isItem: boolean;
  /** See BlockPlacement.meta. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type Placement = BlockPlacement | FreePlacement;

/** Per-layer grid configuration — each layer can have its own resolution. */
export interface LayerSettings {
  /** Grid step in metres. Defaults to the game's native 32x8x32 cell. */
  gridStep: Vec3;
  /** LOD: real meshes load within this range of the camera (metres). */
  lodDistance: number;
}

export const DEFAULT_LOD_DISTANCE = 700;

/**
 * Rigid transform applied to the whole layer (rotation about the layer
 * origin, then translation). Metres; rotation is Euler YXZ in DEGREES
 * [x, y, z] using three.js sign conventions — layers are independent planes
 * that can tilt on any axis.
 */
export interface LayerTransform {
  translate: Vec3;
  rotDeg: Vec3;
}

export interface Layer {
  readonly id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Keep this layer's plane at or above the base grid (no going underground). */
  clampToBase: boolean;
  settings: LayerSettings;
  transform: LayerTransform;
  readonly placements: Map<string, Placement>;
}

export function createLayer(name: string): Layer {
  return {
    id: newId("layer"),
    name,
    visible: true,
    locked: false,
    clampToBase: false,
    settings: { gridStep: CELL, lodDistance: DEFAULT_LOD_DISTANCE },
    transform: { translate: [0, 0, 0], rotDeg: [0, 0, 0] },
    placements: new Map(),
  };
}

/**
 * Sub-base clamp: if the layer's plane rectangle (rotated about the layer
 * origin) would dip below the base grid (world y 0), raise the translation
 * so its lowest corner sits exactly at base level. The layer keeps rotating
 * — it just auto-lifts instead of going underground. Also stops plain
 * downward translation below the base.
 */
export function clampTransformToBase(
  t: LayerTransform,
  worldW: number,
  worldD: number,
): LayerTransform {
  const q = quatFromEulerYXZ([
    degToRad(t.rotDeg[0]),
    degToRad(t.rotDeg[1]),
    degToRad(t.rotDeg[2]),
  ]);
  let minY = 0;
  for (const corner of [
    [0, 0, 0],
    [worldW, 0, 0],
    [worldW, 0, worldD],
    [0, 0, worldD],
  ] as Vec3[]) {
    minY = Math.min(minY, quatRotate(q, corner)[1]);
  }
  const lowest = t.translate[1] + minY;
  if (lowest >= 0) return t;
  return {
    translate: [t.translate[0], -minY || 0, t.translate[2]],
    rotDeg: t.rotDeg,
  };
}

export function isIdentityTransform(t: LayerTransform): boolean {
  return (
    t.rotDeg.every((v) => v === 0) &&
    t.translate.every((v) => v === 0)
  );
}
