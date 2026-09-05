/**
 * TM2020 color palettes. A painted block stores a SLOT (the legacy enum
 * White/Green/Blue/Red/Black); the map's chosen palette defines what the
 * five slots actually look like — e.g. under "Purple" every slot is a
 * purple shade. Hues eyeballed from the game's palette picker.
 */

export const PAINT_SLOTS = ["White", "Green", "Blue", "Red", "Black"] as const;
export type PaintSlot = (typeof PAINT_SLOTS)[number];

/**
 * Rows are SLOT-ordered [White, Green, Blue, Red, Black]. The game's picker
 * displays monochrome rows dark→light, but the White slot maps to the
 * LIGHTEST shade (verified against in-game renders) — so monochrome rows
 * here run light→dark.
 */
export const PALETTES: Record<string, [string, string, string, string, string]> = {
  Classic: ["#f2f2f2", "#3ba55d", "#3b78d8", "#d33b3b", "#262626"],
  Stunt: ["#5fe8d0", "#c8e87a", "#e8a878", "#e88fd8", "#78a8e8"],
  Red: ["#f05050", "#e03030", "#c22828", "#9e2020", "#701818"],
  Orange: ["#f8a018", "#e8820e", "#c2660c", "#a04e0a", "#7a3a08"],
  Yellow: ["#f8e858", "#e8ca10", "#bca20c", "#947c0a", "#6e5c08"],
  Lime: ["#b8f048", "#98dc10", "#78b40c", "#5a8c0a", "#3a5c08"],
  Green: ["#20e860", "#18cc4c", "#14a83e", "#108030", "#0c5c24"],
  Cyan: ["#40e8e8", "#14d0d0", "#10a8a8", "#0c8080", "#0a5c5c"],
  Blue: ["#48a8f8", "#2090f0", "#1470e0", "#1054b8", "#0c3a8c"],
  Purple: ["#c060f8", "#a030f0", "#8018e0", "#6410b8", "#4a0a8c"],
  Pink: ["#f858b8", "#f0289a", "#d0187e", "#a01060", "#6e0a3a"],
  White: ["#f8f8f8", "#dcdcdc", "#c0c0c0", "#a8a8a8", "#909090"],
  Black: ["#9a9a9a", "#7a7a7a", "#5a5a5a", "#3a3a3a", "#181818"],
};

export const PALETTE_NAMES = Object.keys(PALETTES);

/** Resolve a stored slot name to its hex under the given palette. */
export function paintHex(palette: string, slot: string): string | null {
  const idx = (PAINT_SLOTS as readonly string[]).indexOf(slot);
  if (idx < 0) return null;
  return (PALETTES[palette] ?? PALETTES.Classic)[idx];
}
