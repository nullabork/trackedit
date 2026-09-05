import type { EditorContext } from "@plugins/api";
import type { RenderPrefs } from "@render/SceneView";
import { DEFAULT_RENDER_PREFS } from "@render/SceneView";
import { el } from "./dom";
import { openDialog } from "./dialog";

/**
 * Render settings: how the EDITOR draws the viewport — never map data,
 * nothing here exports. Persisted per machine (localStorage), applied at
 * boot (see main.ts).
 *
 *   Skybox    mood photo  |  solid color (pick any)
 *   Lighting  time of day (tinted sun + shadows)  |  flat white, no shadows
 */

const KEY = "trackedit.render";

export function loadRenderPrefs(): RenderPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<RenderPrefs>;
    return { ...DEFAULT_RENDER_PREFS, ...stored };
  } catch {
    return { ...DEFAULT_RENDER_PREFS };
  }
}

function saveRenderPrefs(prefs: RenderPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}

export function openRenderSettings(ctx: EditorContext): void {
  const prefs = ctx.view.getRenderPrefs();
  const apply = () => {
    ctx.view.setRenderPrefs(prefs);
    saveRenderPrefs(prefs);
    render();
  };

  // Segmented pair: two buttons, the active one highlighted.
  const seg = <T extends string>(
    options: Array<{ label: string; value: T }>,
    get: () => T,
    set: (v: T) => void,
  ) => {
    const buttons = options.map((o) => {
      const b = el("button", { class: "btn seg-btn" }, o.label) as HTMLButtonElement;
      b.addEventListener("click", () => {
        set(o.value);
        apply();
      });
      return { b, o };
    });
    const refresh = () => {
      for (const { b, o } of buttons) b.classList.toggle("primary", get() === o.value);
    };
    refreshers.push(refresh);
    return el("div", { class: "seg-row" }, ...buttons.map((x) => x.b));
  };
  const refreshers: Array<() => void> = [];

  const colorInput = el("input", { type: "color" }) as HTMLInputElement;
  colorInput.value = prefs.skyColor;
  colorInput.addEventListener("input", () => {
    prefs.skyColor = colorInput.value;
    if (prefs.sky === "color") apply();
  });
  const colorRow = el("div", { class: "field sky-color-row" },
    el("label", {}, "Sky color"),
    colorInput,
  );

  const content = el("div", { class: "render-settings" },
    el("p", { class: "hint" },
      "Editor viewport only — none of this changes the map or what it looks like in game."),
    el("div", { class: "field" },
      el("label", {}, "Skybox"),
      seg(
        [{ label: "Sky image", value: "image" as const }, { label: "Solid color", value: "color" as const }],
        () => prefs.sky,
        (v) => (prefs.sky = v),
      ),
    ),
    colorRow,
    el("div", { class: "field" },
      el("label", {}, "Lighting"),
      seg(
        [{ label: "Time of day", value: "mood" as const }, { label: "Flat white", value: "flat" as const }],
        () => prefs.lighting,
        (v) => (prefs.lighting = v),
      ),
      el("div", { class: "hint" },
        "Time of day tints light to the map's mood and casts shadows; " +
        "flat white lights everything evenly with no shadows."),
    ),
  );

  const render = () => {
    for (const r of refreshers) r();
    colorRow.hidden = prefs.sky !== "color";
  };
  render();

  openDialog({ title: "Render settings", content, width: 360 });
}
