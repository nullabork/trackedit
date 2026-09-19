import type { EditorContext } from "@plugins/api";
import type { CustomFog, CustomSun } from "@core/atmosphere";
import {
  DEFAULT_FOG, MOOD_SUNS, clockOf, customSunFrom, headingAltitude, isDaylight, lightDirection, sunFromHeading,
} from "@core/atmosphere";
import { sunDirection } from "@core/sun";
import type { Shell } from "./Shell";
import { el } from "./dom";
import { saveToGameFlow } from "./mapActions";

const SUN_DEFAULT = "#fff1c4";
const MOON_DEFAULT = "#9fb8ff";

/**
 * The "Sky & light" drawer page: where the sun is (numbers here, dragging
 * with the sun tool), its colour and the moon's, fog and sky tint, and a
 * custom sky image. Everything is stored on the document (core/atmosphere.ts),
 * previewed in the viewport while this page or the sun tool is in use, and
 * written into the map by "Save to Trackmania".
 */
export function buildSkyPanel(ctx: EditorContext, shell: Shell): void {
  const doc = ctx.document;
  const root = el("div", { class: "sky-panel" });
  shell.registerDrawerPage({ id: "sky", label: "Sky & light", element: root });

  /** Controls re-read the document, except the one being typed in or dragged. */
  const syncers: Array<() => void> = [];
  const bind = <T extends HTMLInputElement | HTMLSelectElement>(input: T, read: () => string, write: (value: string) => void, event = "input"): T => {
    input.addEventListener(event, () => write(input.value));
    syncers.push(() => {
      if (document.activeElement !== input) input.value = read();
    });
    return input;
  };
  const check = (label: string, read: () => boolean, write: (on: boolean) => void) => {
    const box = el("input", { type: "checkbox" });
    box.addEventListener("change", () => write(box.checked));
    syncers.push(() => (box.checked = read()));
    return el("label", { class: "check" }, box, label);
  };
  const range = (min: number, max: number, step: number, read: () => number, write: (v: number) => void) =>
    bind(el("input", { type: "range", min, max, step }), () => String(read()), (v) => write(Number(v)));
  const number = (min: number, max: number, step: number, read: () => number, write: (v: number) => void) =>
    bind(el("input", { class: "input", type: "number", min, max, step }), () => String(Math.round(read() * 10) / 10),
      (v) => Number.isFinite(Number(v)) && v !== "" && write(Number(v)), "change");
  const field = (label: string, ...controls: Array<HTMLElement | null>) => el("div", { class: "field" }, el("label", {}, label), ...controls);

  // --- sun ---------------------------------------------------------------
  const sunOf = (): CustomSun => doc.atmosphere.sun ?? customSunFrom(ownSun());
  const ownSun = () => {
    const own = MOOD_SUNS[doc.mood] ?? MOOD_SUNS.Day;
    return isDaylight(own) ? own : MOOD_SUNS.Day;
  };
  const patchSun = (patch: Partial<CustomSun>) => doc.setAtmosphere({ sun: { ...sunOf(), ...patch } });
  const compass = () => headingAltitude(doc.atmosphere.sun ? sunDirection(doc.atmosphere.sun) : lightDirection(doc.mood, null));
  const place = (heading: number, altitude: number) => patchSun(sunFromHeading(heading, altitude));

  const readout = el("p", { class: "hint" });
  syncers.push(() => {
    const s = doc.atmosphere.sun;
    readout.textContent = s
      ? `Game settings: DayTime01 ${s.dayTime01.toFixed(4)} (${clockOf(s.dayTime01)} on the map's clock), Latitude ${s.latitude.toFixed(2)}.`
      : `The ${doc.mood} mood's own sun. Drag it, or change a number, to make it yours.`;
  });
  const colour = (read: () => string | null, fallback: string, write: (v: string | null) => void) => {
    const input = bind(el("input", { type: "color" }), () => read() ?? fallback, (v) => write(v));
    const own = el("button", { class: "btn", title: "Back to the mood's own colour", onclick: () => write(null) }, "mood's own");
    syncers.push(() => (own.disabled = read() === null));
    return [input, own];
  };

  const sunSection = el("section", {},
    el("h3", {}, "Sun"),
    el("div", { class: "sky-buttons" },
      el("button", { class: "btn primary", onclick: () => ctx.tools.setActive("sun") }, "Place the sun"),
      el("button", { class: "btn", onclick: () => doc.setAtmosphere({ sun: null }) }, "Reset to the mood's"),
    ),
    field("Heading (° from North)", number(0, 360, 1, () => compass().heading, (v) => place(v, compass().altitude))),
    field("Height (°)", number(1, 90, 1, () => compass().altitude, (v) => place(compass().heading, v))),
    readout,
    field("Sun colour", ...colour(() => doc.atmosphere.sun?.color ?? null, SUN_DEFAULT, (v) => patchSun({ color: v }))),
    field("Sun brightness", range(0, 3, 0.05, () => sunOf().intensity, (v) => patchSun({ intensity: v }))),
    field("Moon colour", ...colour(() => doc.atmosphere.sun?.moonColor ?? null, MOON_DEFAULT, (v) => patchSun({ moonColor: v }))),
    field("Moon brightness", range(0, 3, 0.05, () => sunOf().moonIntensity, (v) => patchSun({ moonIntensity: v }))),
    el("p", { class: "hint" }, "The moon sits opposite the sun. It only lights the map in the Night mood, whose own light the editor does not model yet."),
  );

  // --- fog ---------------------------------------------------------------
  const fogOf = (): CustomFog => doc.atmosphere.fog ?? DEFAULT_FOG;
  const patchFog = (patch: Partial<CustomFog>) => doc.setAtmosphere({ fog: { ...fogOf(), ...patch } });
  const fogSection = el("section", {},
    el("h3", {}, "Fog and tint"),
    check("Custom fog", () => doc.atmosphere.fog !== null, (on) => doc.setAtmosphere({ fog: on ? { ...fogOf() } : null })),
    field("Colour", bind(el("input", { type: "color" }), () => fogOf().color, (v) => patchFog({ color: v }))),
    field("Strength", range(0, 1, 0.01, () => fogOf().intensity, (v) => patchFog({ intensity: v }))),
    field("Sky tint", range(0, 1, 0.01, () => fogOf().skyIntensity, (v) => patchFog({ skyIntensity: v }))),
    field("Distance (m)", number(100, 20000, 100, () => fogOf().distance, (v) => patchFog({ distance: Math.max(100, v) }))),
    field("Clouds", range(0, 1, 0.01, () => fogOf().cloudsOpacity, (v) => patchFog({ cloudsOpacity: v }))),
    el("p", { class: "hint" }, "Written as a MediaTracker fog clip that starts on the start block and keeps playing. Sky tint is how much of the colour washes over the sky itself."),
  );

  // --- sky image ---------------------------------------------------------
  const skyName = el("span", { class: "sky-file" });
  syncers.push(() => (skyName.textContent = doc.atmosphere.sky?.image ?? "the mood's own sky"));
  const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  file.addEventListener("change", async () => {
    const picked = file.files?.[0];
    if (!picked) return;
    try {
      const res = await fetch(`/api/game/sky?name=${encodeURIComponent(picked.name)}&doc=${encodeURIComponent(doc.id)}`, { method: "POST", body: picked });
      const json = (await res.json()) as { file?: string; error?: string };
      if (!res.ok || !json.file) throw new Error(json.error ?? `HTTP ${res.status}`);
      doc.setAtmosphere({ sky: { image: json.file, exposure: doc.atmosphere.sky?.exposure ?? 1, clouds: doc.atmosphere.sky?.clouds ?? "clear" } });
    } catch (err) {
      ctx.ui.setStatus(`Sky image failed: ${err instanceof Error ? err.message : err}`);
    }
    file.value = "";
  });
  const clouds = bind(el("select", { class: "input" }, el("option", { value: "clear" }, "cleared"), el("option", { value: "keep" }, "the mood's own")),
    () => doc.atmosphere.sky?.clouds ?? "clear",
    (v) => doc.atmosphere.sky && doc.setAtmosphere({ sky: { ...doc.atmosphere.sky, clouds: v as "keep" | "clear" } }), "change");
  const skySection = el("section", {},
    el("h3", {}, "Sky image"),
    field("Image", skyName),
    el("div", { class: "sky-buttons" },
      el("button", { class: "btn", onclick: () => file.click() }, "Choose image…"),
      el("button", { class: "btn", onclick: () => doc.setAtmosphere({ sky: null }) }, "Remove"),
    ),
    field("Exposure", range(0.1, 4, 0.05, () => doc.atmosphere.sky?.exposure ?? 1,
      (v) => doc.atmosphere.sky && doc.setAtmosphere({ sky: { ...doc.atmosphere.sky, exposure: v } }))),
    field("Clouds", clouds),
    el("p", { class: "hint" },
      "The game stretches the image over HALF the sky and mirrors it for the other half: the left edge sits at the sun, the right edge opposite it, top = straight up, middle = horizon. " +
      "It draws its own sun disc on top, so paint none. Needs Python with numpy and Pillow on this machine when saving."),
  );

  const saveNote = el("p", { class: "hint" },
    "Save to Trackmania writes all of this into the map: the sun and sky as a mod in the game's Skins/Stadium/Mod folder, the fog as a clip. " +
    "Compute shadows in the game afterwards — the bake uses this sun. The mod is a local file, so for now the look only shows on this machine.");
  root.append(sunSection, fogSection, skySection,
    el("div", { class: "sky-buttons" }, el("button", { class: "btn primary", onclick: () => void saveToGameFlow(ctx) }, "Save to Trackmania…")), saveNote);

  const sync = () => {
    for (const s of syncers) s();
  };
  doc.events.on("atmosphereChanged", sync);
  doc.events.on("mapChanged", sync);
  doc.events.on("reset", sync);
  sync();

  // The viewport shows the game's light and sky while this page is open or
  // the sun tool is active, whatever the render prefs say.
  const preview = () => ctx.view.setAtmospherePreview(ctx.tools.activeTool?.id === "sun" || shell.isDrawerPageOpen("sky"));
  shell.onDrawerChanged(preview);
  ctx.tools.events.on("activeChanged", preview);
}
