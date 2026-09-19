/**
 * TM2020 block paint. A painted block stores a SLOT (the legacy enum
 * White/Green/Blue/Red/Black). What a slot looks like is two lookups away:
 * the MAP picks a palette (Classic, Stunt, Red, Orange, … — chunk
 * 0x0304306C, "Classic" on maps saved before palettes existed), and each
 * MATERIAL names a colour target table (Default, Sport, Fun, TrackWall,
 * Canopy, …) whose row for that palette holds the five slot colours in slot
 * order. `meshdump colortables` exports the game's tables to
 * public/meshes/colortables.json and tags materials.json with each
 * material's table; the built-in DEFAULT_TABLE below is the game's Default
 * table, used until that file loads (or when it is missing).
 */

export const PAINT_SLOTS = ["White", "Green", "Blue", "Red", "Black"] as const;
export type PaintSlot = (typeof PAINT_SLOTS)[number];

/** Palette rows in the order the map file indexes them. */
export const PALETTE_NAMES = [
  "Classic", "Stunt", "Red", "Orange", "Yellow", "Lime", "Green", "Cyan", "Blue", "Purple", "Pink", "White", "Black",
] as const;

export type PaletteRow = [string, string, string, string, string];
export type ColorTable = Record<string, PaletteRow>;
export type ColorTables = Record<string, ColorTable>;

/** The game's Default colour target table (Media/ColorTargetTables/Default). */
export const DEFAULT_TABLE: ColorTable = {
  Classic: ["#f7f7f7", "#349857", "#3a85cf", "#c51818", "#222222"],
  Stunt: ["#6df1dd", "#cef16d", "#f1a66d", "#f48dea", "#6da2f1"],
  Red: ["#6b0000", "#8c0000", "#ba0000", "#df0000", "#ff4341"],
  Orange: ["#773000", "#b65300", "#df6d00", "#f97c00", "#ff990e"],
  Yellow: ["#594508", "#a77d00", "#daad00", "#ffde00", "#ffed5e"],
  Lime: ["#2e5000", "#599500", "#7ec500", "#9ce700", "#c8ff38"],
  Green: ["#004d17", "#007d0f", "#00a91c", "#00c933", "#12ea52"],
  Cyan: ["#004548", "#007074", "#00a9af", "#00cad2", "#42f2f7"],
  Blue: ["#00327c", "#0058c9", "#006ef5", "#008cff", "#2facff"],
  Purple: ["#5b0185", "#8000cf", "#ac00ff", "#c729ff", "#dc66ff"],
  Pink: ["#6a0746", "#b10071", "#dc008a", "#f92daf", "#ff65cb"],
  White: ["#858585", "#a2a2a2", "#c6c6c6", "#dddddd", "#f9f9f9"],
  Black: ["#202020", "#535353", "#747474", "#8b8b8b", "#a5a5a5"],
};

/** Kept for the swatch UI and tests: the Default table by palette. */
export const PALETTES: Record<string, PaletteRow> = DEFAULT_TABLE;

let tables: ColorTables = { Default: DEFAULT_TABLE };

/** Install the exported game tables (colortables.json). */
export function setColorTables(loaded: ColorTables): void {
  tables = { Default: DEFAULT_TABLE, ...loaded };
}

export function colorTables(): ColorTables {
  return tables;
}

/**
 * Resolve a stored slot to its hex for a map palette and a material's colour
 * table. Most material tables (Sport, TrackWall, Canopy, …) only restyle the
 * Classic and Stunt rows; for any other palette the Default table's row
 * applies (an all-orange map is orange on walls and platforms alike).
 * Unknown tables fall back to Default, unknown palettes to Classic.
 */
export function paintHex(palette: string, slot: string, table = "Default"): string | null {
  const idx = (PAINT_SLOTS as readonly string[]).indexOf(slot);
  if (idx < 0) return null;
  const own = tables[table] ?? tables.Default ?? DEFAULT_TABLE;
  const def = tables.Default ?? DEFAULT_TABLE;
  const row = own[palette] ?? def[palette] ?? DEFAULT_TABLE[palette] ?? own.Classic ?? DEFAULT_TABLE.Classic;
  return row[idx];
}
