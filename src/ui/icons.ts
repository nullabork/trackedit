import { el } from "./dom";

/** 16×16 stroke icons (style guide §5.1): geometric, currentColor. */
export const ICONS: Record<string, string> = {
  place: '<path d="M2 6l6-3 6 3-6 3z"/><path d="M2 6v5l6 3 6-3V6"/><path d="M8 9v5"/>',
  select: '<path d="M3 2l4 11 2-5 5-2z"/>',
  erase: '<path d="M5 9l5-6 4 3-5 6H6z"/><path d="M2 13h12"/>',
  import: '<path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 13h10"/>',
  export: '<path d="M8 10V2M5 5l3-3 3 3"/><path d="M3 13h10"/>',
  undo: '<path d="M6 3L3 6l3 3"/><path d="M3 6h7a3 3 0 0 1 0 6H8"/>',
  redo: '<path d="M10 3l3 3-3 3"/><path d="M13 6H6a3 3 0 0 0 0 6h2"/>',
  eye: '<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
  "eye-off": '<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z"/><path d="M3 13L13 3"/>',
  lock: '<rect x="4" y="7" width="8" height="6"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  unlock: '<rect x="4" y="7" width="8" height="6"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0"/>',
  gear: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  folder: '<path d="M2 4h4l2 2h6v7H2z"/>',
  gridmode: '<path d="M2 6h12M2 10h12M6 2v12M10 2v12"/>',
  freemode: '<circle cx="5" cy="5.5" r="1.4"/><circle cx="11.5" cy="4" r="1.4"/><circle cx="7" cy="11.5" r="1.4"/><circle cx="12" cy="10" r="1.4"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M13 3l-1.5 1.5M4.5 11.5L3 13"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/>',
  sunrise: '<path d="M4 11a4 4 0 0 1 8 0"/><path d="M8 3v3M2 11h12M4 5.5L5.5 7M12 5.5L10.5 7"/>',
  sunset: '<path d="M4 10a4 4 0 0 1 8 0"/><path d="M2 10h12M2 13h12M8 3v3"/>',
  paint: '<path d="M2 3h9v4H2zM11 4.5h3v3h-3zM7.5 7v3M6.5 10h2v4h-2z"/>',
  brush: '<path d="M10 2l4 4-6 6-4-4zM4 8l-1.5 4.5L7 11"/>',
  spinner: '<path d="M8 2a6 6 0 1 1-6 6"/>',
  assets: '<path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z"/><path d="M2.5 4.5L8 7.5l5.5-3M8 7.5V14"/>',
};

export function icon(name: string): HTMLElement {
  const span = el("span", { class: "icon" });
  span.innerHTML = `<svg viewBox="0 0 16 16">${ICONS[name] ?? ""}</svg>`;
  return span;
}
