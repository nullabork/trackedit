import type { EditorContext } from "@plugins/api";
import type { RenderPrefs } from "@render/SceneView";
import { DEFAULT_RENDER_PREFS } from "@render/SceneView";
import { clear, el } from "./dom";
import { openDialog } from "./dialog";

/**
 * Render settings: how the EDITOR draws the viewport — never map data,
 * nothing here exports. Persisted per machine (localStorage), applied at
 * boot (see main.ts).
 *
 *   View     skybox image | solid colour; lighting; grid distance; ghost tube
 *   Colours  selection box, background, layer grid, layer plane, X/Y/Z axes
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

type ColorKey = "skyColor" | "gridColor" | "selectionColor" | "axisX" | "axisY" | "axisZ" | "planeColor";

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

  // Colour field bound to one pref; `when` gates whether changing it repaints.
  const colorField = (label: string, key: ColorKey, hint?: string, when: () => boolean = () => true) => {
    const input = el("input", { type: "color" }) as HTMLInputElement;
    input.value = prefs[key];
    input.addEventListener("input", () => {
      prefs[key] = input.value;
      if (when()) apply();
    });
    const reset = el("button", { class: "btn", type: "button", title: "Reset to default" }, "↺") as HTMLButtonElement;
    reset.addEventListener("click", () => {
      prefs[key] = DEFAULT_RENDER_PREFS[key];
      input.value = prefs[key];
      apply();
    });
    return el("div", { class: "field sky-color-row" },
      el("label", {}, label),
      el("div", { class: "color-row" }, input, reset),
      hint ? el("div", { class: "hint" }, hint) : null,
    );
  };

  const slider = (label: string, key: "gridFade" | "ghostRadius", min: number, max: number, step: number,
    fmt: (v: number) => string, hint: string) => {
    const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
    input.value = String(prefs[key]);
    const value = el("span", { class: "grid-fade-value" }, fmt(prefs[key]));
    input.addEventListener("input", () => {
      prefs[key] = Number(input.value);
      value.textContent = fmt(prefs[key]);
      apply();
    });
    return el("div", { class: "field" },
      el("label", {}, label),
      el("div", { class: "grid-fade-row" }, input, value),
      el("div", { class: "hint" }, hint),
    );
  };

  // --- View tab ---
  const skyColorRow = colorField("Sky color", "skyColor", undefined, () => prefs.sky === "color");
  const viewTab = el("div", { class: "render-settings" },
    el("div", { class: "field" },
      el("label", {}, "Skybox"),
      seg(
        [{ label: "Sky image", value: "image" as const }, { label: "Solid color", value: "color" as const }],
        () => prefs.sky,
        (v) => (prefs.sky = v),
      ),
    ),
    skyColorRow,
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
    slider("Grid distance", "gridFade", 0, 100, 1, (v) => `${v}%`,
      "How far the layer grid reaches before it dissolves around where you look."),
    slider("Ghost line thickness", "ghostRadius", 0.3, 5, 0.1, (v) => `${v.toFixed(1)} m`,
      "Radius of the ghost driving tube drawn under a TMX map's layer."),
  );

  // --- Colours tab ---
  const colorsTab = el("div", { class: "render-settings" },
    colorField("Selection box", "selectionColor", "Outline of selected blocks, except its three axis edges."),
    el("div", { class: "field" },
      el("label", {}, "Selection axes"),
      el("div", { class: "axis-colors" },
        axisSwatch("X", "axisX"), axisSwatch("Y", "axisY"), axisSwatch("Z", "axisZ"),
      ),
      el("div", { class: "hint" }, "The three edges meeting at the selection's corner, and their tags."),
    ),
    colorField("Background", "skyColor", "Used when the skybox is set to a solid colour (View tab).", () => prefs.sky === "color"),
    colorField("Layer grid", "gridColor"),
    colorField("Layer plane", "planeColor", "The square outlining the active layer's ground plane."),
  );

  function axisSwatch(label: string, key: "axisX" | "axisY" | "axisZ") {
    const input = el("input", { type: "color" }) as HTMLInputElement;
    input.value = prefs[key];
    input.addEventListener("input", () => {
      prefs[key] = input.value;
      apply();
    });
    return el("label", { class: "axis-swatch" }, el("span", {}, label), input);
  }

  // --- tabs ---
  const body = el("div", { class: "render-body" });
  let tab: "view" | "colors" = "view";
  const tabView = el("div", { class: "tab active", onclick: () => setTab("view") }, "View");
  const tabColors = el("div", { class: "tab", onclick: () => setTab("colors") }, "Colours");
  const setTab = (t: typeof tab) => {
    tab = t;
    tabView.classList.toggle("active", t === "view");
    tabColors.classList.toggle("active", t === "colors");
    clear(body);
    body.append(t === "view" ? viewTab : colorsTab);
  };

  const render = () => {
    for (const r of refreshers) r();
    skyColorRow.hidden = prefs.sky !== "color";
  };
  render();
  setTab(tab);

  openDialog({ title: "Render settings", width: 380, content: el("div", {},
    el("p", { class: "hint" },
      "Editor viewport only — none of this changes the map or what it looks like in game."),
    el("div", { class: "tabs" }, tabView, tabColors),
    body,
  ) });
}
