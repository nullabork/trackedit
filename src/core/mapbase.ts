import type { GridCoord } from "./math";
import { DEFAULT_Y_OFFSET } from "./math";

/**
 * Map bases the document can sit on. Official decorations are
 * 48x48 / 48x48Screen155 / NoStadium48x48, each in 4 moods; the oversize
 * variants follow the community convention (eyebo's No Stadium base maps:
 * 64³/128³/255³ on the NoStadium decoration with an enlarged map size).
 */

export type Mood = "Sunrise" | "Day" | "Sunset" | "Night";
export const MOODS: Mood[] = ["Sunrise", "Day", "Sunset", "Night"];

export type BaseType = "stadium" | "void";

/** Raw grid level of the starting surface; void maps have no Stadium floor. */
export function initialBuildLevel(type: BaseType): number {
  return type === "stadium" ? DEFAULT_Y_OFFSET : 0;
}

export interface MapBase {
  readonly id: string;
  readonly label: string;
  /** Decoration id without the mood suffix. */
  readonly decoration: string;
  readonly size: GridCoord;
  readonly type: BaseType;
  readonly note?: string;
}

export const MAP_BASES: MapBase[] = [
  { id: "stadium155", label: "Stadium · Screen155", decoration: "48x48Screen155", size: [48, 40, 48], type: "stadium", note: "the modern default base" },
  { id: "stadium", label: "Stadium · Classic", decoration: "48x48", size: [48, 40, 48], type: "stadium", note: "no big screens" },
  { id: "nostadium", label: "No Stadium · 48³", decoration: "NoStadium48x48", size: [48, 40, 48], type: "void", note: "open void, no structure" },
  { id: "nostadium64", label: "No Stadium · 64³", decoration: "NoStadium48x48", size: [64, 64, 64], type: "void", note: "community oversize base" },
  { id: "nostadium128", label: "No Stadium · 128³", decoration: "NoStadium48x48", size: [128, 128, 128], type: "void", note: "community oversize base" },
  { id: "nostadium255", label: "No Stadium · 255³", decoration: "NoStadium48x48", size: [255, 255, 255], type: "void", note: "maximum; heavy in game" },
];

/** Split a full decoration id ("NoStadium48x48Sunset") into base + mood. */
export function parseDecoration(id: string): { base: string; mood: Mood } {
  for (const mood of MOODS)
    if (id.endsWith(mood)) return { base: id.slice(0, -mood.length), mood };
  return { base: id, mood: "Day" };
}

export function baseTypeOf(decorationBase: string): BaseType {
  return decorationBase.startsWith("NoStadium") ? "void" : "stadium";
}
