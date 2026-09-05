import type { BlockCatalog } from "@core/catalog";

/**
 * Block tag taxonomy (docs/STYLE-GUIDE.md §5.3): colors + name heuristics.
 * Later these can be augmented from real BlockInfo metadata (waypoint types
 * already ride in placement meta).
 */

export type TagGroup = "special" | "effect" | "surface" | "geometry";

export interface TagDef {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly group: TagGroup;
  readonly match: RegExp;
}

/** Group order doubles as chip priority (specials first on a row). */
export const TAGS: TagDef[] = [
  { id: "start", label: "start", color: "#35d07f", group: "special", match: /Start(?!.*Curve)/ },
  { id: "checkpoint", label: "cp", color: "#3f9cff", group: "special", match: /Checkpoint/ },
  { id: "finish", label: "finish", color: "#dfe9f2", group: "special", match: /Finish/ },
  { id: "multilap", label: "lap", color: "#3fd0c9", group: "special", match: /Multilap/ },

  { id: "boost", label: "boost", color: "#ff8c1a", group: "effect", match: /Turbo|Boost/ },
  { id: "slowmo", label: "slowmo", color: "#b09aff", group: "effect", match: /SlowMotion/ },
  { id: "reactor", label: "reactor", color: "#ffb03f", group: "effect", match: /Reactor/ },
  { id: "no-engine", label: "no-eng", color: "#f2e63f", group: "effect", match: /NoEngine|NoBrake|NoSteering|Cruise/ },
  { id: "fragile", label: "fragile", color: "#ff8f6f", group: "effect", match: /Fragile/ },

  { id: "tech", label: "tech", color: "#8fa1b3", group: "surface", match: /Tech(?!nics)/ },
  { id: "dirt", label: "dirt", color: "#c9803f", group: "surface", match: /Dirt/ },
  { id: "bump", label: "bump", color: "#a06a52", group: "surface", match: /Bump/ },
  { id: "ice", label: "ice", color: "#6fd3e8", group: "surface", match: /Ice/ },
  { id: "grass", label: "grass", color: "#58c25c", group: "surface", match: /Grass/ },
  { id: "plastic", label: "plastic", color: "#ffd23f", group: "surface", match: /Plastic/ },
  { id: "water", label: "water", color: "#3fa6ff", group: "surface", match: /Water|Lake/ },
  { id: "snow", label: "snow", color: "#dfe9f2", group: "surface", match: /Snow/ },
  { id: "sausage", label: "sausage", color: "#e08b8b", group: "surface", match: /Sausage/ },

  { id: "straight", label: "str", color: "#6c7c8c", group: "geometry", match: /Straight/ },
  { id: "corner", label: "cnr", color: "#9d7bff", group: "geometry", match: /Curve|Turn|Chicane|Diag/ },
  { id: "slope", label: "slope", color: "#c77bd8", group: "geometry", match: /Slope|Tilt|Banked|ToBanked/ },
  { id: "loop", label: "loop", color: "#ff7bb8", group: "geometry", match: /Loop|WallRide|Vertical/ },
  { id: "structure", label: "struct", color: "#7e8ea0", group: "geometry", match: /Pillar|Support|Structure|Wall|Canopy|Deco/ },
];

const byId = new Map(TAGS.map((t) => [t.id, t]));

export function tagDef(id: string): TagDef | undefined {
  return byId.get(id);
}

export function deriveTags(blockName: string): string[] {
  const out: string[] = [];
  for (const t of TAGS) if (t.match.test(blockName)) out.push(t.id);
  return out;
}

/** Precomputed name -> tags for the whole catalog (filtering needs it all). */
export function buildTagIndex(catalog: BlockCatalog): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const def of catalog.defs) index.set(def.name, deriveTags(def.name));
  return index;
}

/** Tags offered in the drawer's quick-filter strip. */
export const FILTER_STRIP = [
  "tech", "dirt", "ice", "grass", "plastic", "water",
  "straight", "corner", "slope", "loop",
  "start", "checkpoint", "finish", "boost",
];
