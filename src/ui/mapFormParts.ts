import type { MapBase, Mood } from "@core/mapbase";
import { MAP_BASES, MOODS } from "@core/mapbase";
import { clear, el } from "./dom";
import { icon } from "./icons";

export const MOOD_ICONS: Record<Mood, string> = {
  Sunrise: "sunrise",
  Day: "sun",
  Sunset: "sunset",
  Night: "moon",
};

/** Selectable map-base list (shared by Map settings and New map dialogs). */
export function baseListEl(
  isActive: (base: MapBase) => boolean,
  onPick: (base: MapBase) => void,
): { root: HTMLElement; refresh: () => void } {
  const root = el("div", { class: "base-list" });
  const refresh = () => {
    clear(root);
    for (const base of MAP_BASES) {
      const row = el("div", { class: `base-row${isActive(base) ? " active" : ""}` },
        el("span", { class: "grow" }, base.label),
        el("span", { class: `tag base-type-${base.type}` }, el("span", {}, base.type)),
        el("span", { class: "base-size" }, `${base.size[0]}×${base.size[1]}×${base.size[2]}`),
      );
      if (base.note) row.title = base.note;
      row.addEventListener("click", () => {
        onPick(base);
        refresh();
      });
      root.append(row);
    }
  };
  refresh();
  return { root, refresh };
}

/** Segmented mood selector with icons. */
export function moodRowEl(
  isActive: (mood: Mood) => boolean,
  onPick: (mood: Mood) => void,
): { root: HTMLElement; refresh: () => void } {
  const root = el("div", { class: "mood-row" });
  const refresh = () => {
    clear(root);
    for (const mood of MOODS) {
      const b = el("button", { class: `mood-opt${isActive(mood) ? " active" : ""}` },
        icon(MOOD_ICONS[mood]),
        el("span", {}, mood),
      );
      b.addEventListener("click", () => {
        onPick(mood);
        refresh();
      });
      root.append(b);
    }
  };
  refresh();
  return { root, refresh };
}
