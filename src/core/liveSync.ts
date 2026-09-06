/** Wire records use game world metres and raw game grid coordinates. */
export interface SyncBlock {
  [key: string]: unknown;
  name: string;
  coord: [number, number, number];
  dir: number;
  isFree: boolean;
  isGhost: boolean;
  isGround: boolean;
  absPos: [number, number, number];
  yawPitchRoll: [number, number, number];
  color: string;
  variant: number;
  /** New palette blocks let the game select the connected/ground variant. */
  autoVariant: boolean;
  mobilIndex: number;
  mobilVariant: number;
  lightmapQuality: number;
  waypoint: { tag: string; order: number } | null;
  protected: boolean;
}

export interface LiveSnapshot {
  mapSession: string;
  revision: number;
  mapName: string;
  decoration: string;
  size: [number, number, number];
  yOffset: number;
  blocks: SyncBlock[];
  items: Array<{ name: string; absPos: [number, number, number]; yawPitchRoll: [number, number, number]; [key: string]: unknown }>;
}

const rounded = (n: number) => Math.round(n * 10000) / 10000;
const vec = (v: unknown, round = true): [number, number, number] => {
  const a = Array.isArray(v) ? v : [0, 0, 0];
  return a.map(n => round ? rounded(Number(n)) : Number(n)) as [number, number, number];
};

/** Explicit fields/order avoid JSON ordering, irrelevant metadata, and float-noise diffs. */
export function normalizeBlock(b: Record<string, unknown>): SyncBlock {
  const free = b.isFree === true;
  return {
    name: String(b.name), coord: free ? [0, 0, 0] : vec(b.coord, false), dir: free ? 0 : Number(b.dir ?? 0),
    isFree: free, isGhost: !free && b.isGhost === true, isGround: !free && b.isGround === true,
    absPos: free ? vec(b.absPos) : [0, 0, 0], yawPitchRoll: free ? vec(b.yawPitchRoll) : [0, 0, 0],
    color: String(b.color ?? "Default"), variant: Number(b.variant ?? 0), autoVariant: b.autoVariant === true || b.variant == null, mobilIndex: Number(b.mobilIndex ?? 0),
    mobilVariant: Number(b.mobilVariant ?? 63), lightmapQuality: Number(b.lightmapQuality ?? 0),
    waypoint: b.waypoint ? { tag: String((b.waypoint as { tag: string }).tag), order: Number((b.waypoint as { order: number }).order) } : null,
    protected: b.protected === true,
  };
}

export const blockKey = (b: SyncBlock): string => JSON.stringify(normalizeBlock(b as unknown as Record<string, unknown>));
export interface BlockDelta { remove: SyncBlock[]; add: SyncBlock[] }

/** Check the resulting multiset, so an automatic replacement may resolve to the removed variant. */
export function verifyBlockReadback(before: SyncBlock[], after: SyncBlock[], delta: BlockDelta): void {
  const scopeKey = (b: SyncBlock) => blockKey({ ...b, variant: 0, autoVariant: false, mobilVariant: 0 });
  const scopes = new Set([...delta.remove, ...delta.add].map(scopeKey));
  const expected = mergeBlockDelta(before, delta).filter(b => scopes.has(scopeKey(b)));
  const actual = after.filter(b => scopes.has(scopeKey(b)));
  if (expected.length !== actual.length) throw new Error(`Game readback differs: expected ${expected.length} affected blocks, found ${actual.length}. Sync stopped.`);
  const byScope = new Map<string, number[]>();
  actual.forEach((b, j) => {
    const key = scopeKey(b), bucket = byScope.get(key) ?? [];
    bucket.push(j); byScope.set(key, bucket);
  });
  const candidates = expected.map(b => byScope.get(scopeKey(b)) ?? []);
  const matches = (a: SyncBlock, b: SyncBlock) => (b.autoVariant || a.variant === b.variant)
    && (b.mobilVariant === 63 || a.mobilVariant === b.mobilVariant);
  // Augmenting paths keep duplicate records and overlapping automatic/explicit requests one-to-one.
  const assigned = actual.map(() => -1);
  const assign = (i: number, seen: Set<number>): boolean => {
    for (const j of candidates[i]) {
      if (seen.has(j) || !matches(actual[j], expected[i])) continue;
      seen.add(j);
      if (assigned[j] < 0 || assign(assigned[j], seen)) { assigned[j] = i; return true; }
    }
    return false;
  };
  for (let i = 0; i < expected.length; i++) {
    if (!assign(i, new Set())) throw new Error(`Game readback differs for ${expected[i].name}. Sync stopped; reconnect to inspect the actual map.`);
  }
}

/** A multiset diff preserves duplicate identical blocks. */
export function blockDelta(before: SyncBlock[], after: SyncBlock[]): BlockDelta {
  const remaining = new Map<string, SyncBlock[]>();
  for (const b of before) {
    const key = blockKey(b);
    const bucket = remaining.get(key) ?? [];
    bucket.push(b); remaining.set(key, bucket);
  }
  const add: SyncBlock[] = [];
  for (const b of after) {
    const bucket = remaining.get(blockKey(b));
    if (bucket?.length) bucket.pop(); else add.push(b);
  }
  return { remove: [...remaining.values()].flat(), add };
}

/** Merge local intent into the latest game state; stop on conflicting deletions/replacements. */
export function mergeBlockDelta(remote: SyncBlock[], delta: BlockDelta): SyncBlock[] {
  const merged = [...remote];
  for (const b of delta.remove) {
    const key = blockKey(b);
    const index = merged.findIndex(r => blockKey(r) === key);
    if (index < 0) throw new Error("The same block changed in both editors. Sync paused; your browser edits are kept. Reconnect to reload the game map.");
    if (b.protected) throw new Error("A block with a skin was edited. Skin edits are not supported by live sync yet.");
    merged.splice(index, 1);
  }
  for (const b of delta.add) {
    if (b.protected) throw new Error("Blocks with skins cannot be created or changed by live sync yet.");
    merged.push(b);
  }
  return merged;
}

export function validateSyncBlock(value: unknown): asserts value is SyncBlock {
  if (!value || typeof value !== "object") throw new Error("Invalid block.");
  const b = value as SyncBlock;
  const triple = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
  if (typeof b.name !== "string" || !b.name || b.name.length > 512 || !triple(b.coord) || !triple(b.absPos) || !triple(b.yawPitchRoll)) throw new Error("Invalid block name or coordinates.");
  if (![b.isFree, b.isGround, b.isGhost, b.protected].every(v => typeof v === "boolean")) throw new Error("Invalid block flags.");
  if (b.autoVariant !== undefined && typeof b.autoVariant !== "boolean") throw new Error("Invalid automatic variant flag.");
  if (!Number.isInteger(b.dir) || b.dir < 0 || b.dir > 3 || (!b.isFree && !b.coord.every(n => Number.isInteger(n) && n >= 0 && n <= 255))) throw new Error("Invalid block grid placement.");
  if (!["Default", "White", "Green", "Blue", "Red", "Black"].includes(b.color)) throw new Error("Invalid block color.");
  if (![b.variant, b.mobilIndex, b.mobilVariant, b.lightmapQuality].every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) throw new Error("Invalid block variant.");
  if (b.waypoint !== null && (typeof b.waypoint?.tag !== "string" || !Number.isInteger(b.waypoint.order) || b.waypoint.order < 0)) throw new Error("Invalid waypoint.");
}
