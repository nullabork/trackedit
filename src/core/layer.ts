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
   * Per-placement visibility override (editor only, never exported): true
   * shows it even when its block group is hidden, false hides it; absent
   * follows the group. See isPlacementVisible.
   */
  readonly visible?: boolean;
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
   * Where the model's origin sits relative to the anchor point, in
   * model-local metres (the game's PivotPosition). `pos` is the anchor and
   * rotation happens around it; the mesh is drawn from `pos + R * pivot`.
   * Absent when the origin is the anchor (official items).
   */
  readonly pivot?: Vec3;
  /**
   * Whether this is an item (CGameCtnAnchoredObject) or a free block.
   * Recorded at creation so export doesn't have to guess from the catalog —
   * imported maps can contain custom items the catalog has never seen.
   */
  readonly isItem: boolean;
  /** See BlockPlacement.visible. */
  readonly visible?: boolean;
  /** See BlockPlacement.meta. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type Placement = BlockPlacement | FreePlacement;

/**
 * Which of its block's variants a placed block uses, from the map file's
 * block flags (bits 21 and up): 0 = the base variant, 1 = "InPillar" (the
 * look a block takes stacked inside a pillar), 2 and up = further layouts a
 * block defines (deco-wall loop ends, for one, come in a second, mirrored
 * layout). The game's block definitions list them as AdditionalVariantsAir /
 * AdditionalVariantsGround; `meshdump blocks` exports each that differs.
 */
/**
 * The grid level blocks sit on the terrain at. Measured over real maps: every
 * block a map file flags as "ground" sits at level 9 (the decoration's
 * vertical origin, 8, plus one), none at 8.
 */
export const GROUND_LEVEL = 9;

/**
 * Air or ground look of a grid block. The map file says it outright
 * (`isGround`, carried in the placement's meta) and that is what the game
 * draws, so an imported block uses it — also above level 9: terrain rises
 * (hills), and ground blocks rise with it. Blocks without the flag (made in
 * the editor, or moved to another level — see `metaAfterMove`) are ground
 * exactly when they sit at ground level on a stadium base.
 */
export function blockIsGround(p: Pick<BlockPlacement, "meta" | "coord">, stadiumBase: boolean): boolean {
  const flag = (p.meta as { isGround?: boolean } | undefined)?.isGround;
  if (typeof flag === "boolean") return flag;
  return stadiumBase && p.coord[1] === GROUND_LEVEL;
}

/**
 * A grid block's meta after a move: changing level invalidates what the map
 * file said about standing on the terrain, so that one field is dropped and
 * the editor's own rule takes over. Everything else rides along.
 */
export function metaAfterMove(meta: BlockPlacement["meta"], fromLevel: number, toLevel: number): BlockPlacement["meta"] {
  if (!meta || fromLevel === toLevel || !("isGround" in meta)) return meta;
  const { isGround: _stale, ...rest } = meta;
  return rest;
}

/**
 * The mesh variant a placement shows: "air" / "ground", plus the index of
 * the block variant it names ("air2", "ground1", …). `lifted`: its layer is
 * tilted or raised, which takes every block in it off the terrain. The one
 * place this is decided — the renderer draws it, tools/variant_check.ts
 * verifies it against what the map file says.
 *
 * A FREE block names a variant exactly like a grid block (same flag bits) and
 * is never a ground variant (0 of 658 across the cached maps). Items have no
 * variants.
 */
export function placementVariant(p: Placement, stadiumBase: boolean, lifted = false): string {
  if (p.kind === "free") {
    const index = p.isItem ? 0 : blockVariantIndex(p);
    return index ? `air${index}` : "air";
  }
  if (p.kind !== "block") return "air";
  const base = !lifted && blockIsGround(p, stadiumBase) ? "ground" : "air";
  const index = blockVariantIndex(p);
  return index ? `${base}${index}` : base;
}

/**
 * Which MOBIL of its variant a placed block shows, as "<row>_<col>", or "" for the base
 * [0][0]. Row = the block's Variant (flag bits 0-5): e.g. which height piece of a pillar,
 * one of them empty. Column = SubVariant (bits 6-11): an alternative build — another shape
 * ("B"), other materials ("v2"). Items have none. tools/variant_check.ts verifies every
 * named mobil exists in the block's definition.
 */
export function placementMobil(p: Placement): string {
  if (p.kind !== "block" && !(p.kind === "free" && !p.isItem)) return "";
  const flags = Number((p.meta as { flags?: number } | undefined)?.flags ?? 0);
  const row = flags & 0x3f, col = (flags >>> 6) & 0x3f;
  return row || col ? `${row}_${col}` : "";
}

/**
 * The surface skin a placed block carries, as the name of a terrain modifier ("PlatformGrass",
 * "PlatformIce", …), or "". The game stores it on pillar blocks under a platform
 * (`Skin.Text = "PlatformGrass\"`) and swaps their materials for that modifier's — the same
 * swap a block with a modifier of its own gets at extraction. A skin that names an image pack
 * (a sign) is something else and not handled here.
 */
export function placementSkin(p: Placement): string {
  if (p.kind !== "block" && !(p.kind === "free" && !p.isItem)) return "";
  const skin = (p.meta as { skin?: { text?: string; pack?: { file?: string; url?: string } } } | undefined)?.skin;
  if (!skin?.text || skin.pack?.file || skin.pack?.url) return "";
  return skin.text.replace(/[\\/]+$/, "");
}

/**
 * The light-colour skin an ITEM carries ("skins\stadium\lightcolors\coral.dds", lower-cased as
 * lightcolors.json keys it), or "". Lamps, light spheres and light cubes are stored with one;
 * light tubes with the same name under "lighttube" (an empty zip: the name IS the colour).
 */
export function placementLightSkin(p: Placement): string {
  if (p.kind !== "free" || !p.isItem) return "";
  const file = (p.meta as { skin?: { pack?: { file?: string } } } | undefined)?.skin?.pack?.file ?? "";
  return /[\\/]light(colors|tube)[\\/]/i.test(file) ? file.replace(/\//g, "\\").toLowerCase() : "";
}

/** An item's uniform scale (CGameCtnAnchoredObject.Scale); 1 unless the map says otherwise. */
export function placementScale(p: Placement): number {
  if (p.kind !== "free" || !p.isItem) return 1;
  const scale = Number((p.meta as { scale?: number } | undefined)?.scale ?? 1);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function blockVariantIndex(p: { readonly meta?: Readonly<Record<string, unknown>> }): number {
  return (Number((p.meta as { flags?: number } | undefined)?.flags ?? 0) >>> 21) & 0x3f;
}

/** Per-layer grid configuration — each layer can have its own resolution. */
export interface LayerSettings {
  /** Grid step in metres. Defaults to the game's native 32x8x32 cell. */
  gridStep: Vec3;
  /** LOD: real meshes load within this range of the camera (metres). */
  lodDistance: number;
  /**
   * Rotation snap in degrees while grid constrained, for the layer itself and
   * everything in it (R sequences and the selection box's rotate rings).
   * Unconstrained rotation ignores it. Grid blocks yawed by a non-quarter
   * step convert to free blocks.
   */
  rotationStep: number;
}

export const DEFAULT_LOD_DISTANCE = 700;
export const DEFAULT_ROTATION_STEP = 90;

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

/**
 * A driving line attached to a layer: the map's validation ghost or a TMX
 * replay. Points are layer-local editor metres (same frame as
 * FreePlacement.pos), so the layer transform moves the line with the track.
 */
export interface GhostPath {
  /** Identity for toggling: "map", "tmx:<replayId>", "nadeo:<accountId>". */
  key: string;
  source: "map" | "tmx" | "nadeo";
  /** TMX replay id, when that is where it came from. */
  replayId?: number;
  /** Nadeo account id of the record holder, for leaderboard ghosts. */
  accountId?: string;
  /** Who drove it, and for TMX which replay — status/UI text only. */
  label: string;
  timeMs?: number;
  path: Vec3[];
  /** Sample times in ms, parallel to `path`, when the source had them. */
  times?: number[];
  /**
   * Race times (ms) at which the run took each checkpoint, in order; the last
   * is the finish. From the ghost itself, so exact.
   */
  checkpoints?: number[];
  /**
   * The driver's inputs and the speed per sample, parallel to `path`, when the ghost had
   * them: steer -100..100 (left negative), gas and brake 0..100, speed in km/h.
   */
  steer?: number[];
  gas?: number[];
  brake?: number[];
  speed?: number[];
  /**
   * The car body's orientation per sample: unit quaternions (x, y, z, w) in thousandths,
   * flattened (4 per sample); forward is +z. Not the direction of travel — they part in a drift.
   */
  rot?: number[];
  /**
   * Per wheel (FL, FR, RL, RR; 4 per sample): the wheel's angle in milliradians, cumulative (the game wraps it every 256 turns)
   * over the run, and its damper's extension in mm (~30 on the road, ~190 in the air).
   */
  wheelRot?: number[];
  damper?: number[];
  /** Who drove it, when the source said. */
  driver?: string;
  /** Editor only: false hides the line without unloading it. */
  visible?: boolean;
  /** Editor only: number the checkpoints along the line in the viewport. */
  showNumbers?: boolean;
  /**
   * Editor only: also draw the tries that ended in a respawn before the next
   * checkpoint (see core/ghostRuns). Off by default: a run with a thousand
   * failed jumps is unreadable otherwise.
   */
  showAttempts?: boolean;
  /** Editor only: how solid the attempts are drawn, 0..1 (default 0.5). */
  attemptOpacity?: number;
}

export const DEFAULT_ATTEMPT_OPACITY = 0.5;

/** One hue per line on a layer, by its position in `Layer.ghosts`. */
export const LINE_HUES = ["#2dd4bf", "#f97316", "#a78bfa", "#facc15", "#f472b6", "#38bdf8", "#a3e635", "#f87171"];
export const lineHue = (index: number): string => LINE_HUES[((index % LINE_HUES.length) + LINE_HUES.length) % LINE_HUES.length];

/** The toggle identity of a line: where it came from. */
export function ghostKeyOf(g: { source: "map" | "tmx" | "nadeo"; replayId?: number; accountId?: string }): string {
  if (g.source === "tmx") return `tmx:${g.replayId ?? 0}`;
  if (g.source === "nadeo") return `nadeo:${g.accountId ?? ""}`;
  return "map";
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
  /** Driving lines shown on this layer (any number at once). */
  ghosts: GhostPath[];
  /** Block names whose whole group is hidden in the editor (never exported). */
  hiddenBlocks: string[];
}

/** Whether a placement draws: its own override, else its block group. */
export function isPlacementVisible(layer: Pick<Layer, "hiddenBlocks">, p: Placement): boolean {
  return p.visible ?? !layer.hiddenBlocks.includes(p.block);
}

export function createLayer(name: string): Layer {
  return {
    ghosts: [],
    hiddenBlocks: [],
    id: newId("layer"),
    name,
    visible: true,
    locked: false,
    clampToBase: false,
    settings: { gridStep: CELL, lodDistance: DEFAULT_LOD_DISTANCE, rotationStep: DEFAULT_ROTATION_STEP },
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
