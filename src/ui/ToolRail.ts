import type { EditorContext } from "@plugins/api";
import { MOODS } from "@core/mapbase";
import type { Shell } from "./Shell";
import { clear, el } from "./dom";
import { icon } from "./icons";
import { openDialog } from "./dialog";
import { openTmxDialog } from "./TmxDialog";
import { openMapBrowser } from "./MapBrowserDialog";
import { exportJsonFlow, importJsonFlow } from "./mapActions";
import { openModPicker, toggleMod } from "./mods";
import { mountPaintSwatch } from "./PaintSwatch";
import { fetchSetupStatus, openSetupDialog } from "./SetupDialog";
import { MOOD_ICONS, baseListEl, moodRowEl } from "./mapFormParts";

function railButton(
  iconName: string,
  label: string,
  shortcut: string | null,
  onclick: () => void,
): HTMLButtonElement {
  return el("button", { class: "tbtn", onclick },
    icon(iconName),
    el("span", { class: "tip" }, label, shortcut ? el("b", {}, ` ${shortcut}`) : null),
  );
}

const TOOL_META: Record<string, { icon: string; shortcut: string | null }> = {
  place: { icon: "place", shortcut: "P" },
  select: { icon: "select", shortcut: "E" },
  erase: { icon: "erase", shortcut: null },
  paint: { icon: "brush", shortcut: null },
};

/** Vertical tool rail + status-bar actions. Replaces the old top toolbar. */
export function buildToolRail(ctx: EditorContext, shell: Shell): void {
  const toolButtons = new Map<string, HTMLButtonElement>();

  const refresh = () => {
    const active = ctx.tools.activeTool?.id;
    for (const [id, b] of toolButtons) b.classList.toggle("active", id === active);
  };

  const addToolButton = (toolId: string, label: string) => {
    if (toolButtons.has(toolId)) return;
    const meta = TOOL_META[toolId] ?? { icon: "select", shortcut: null };
    const b = railButton(meta.icon, label, meta.shortcut, () => ctx.tools.setActive(toolId));
    toolButtons.set(toolId, b);
    shell.rail.append(b);
  };

  for (const tool of ctx.tools.all) addToolButton(tool.id, tool.label);
  ctx.tools.events.on("registered", ({ tool }) => {
    addToolButton(tool.id, tool.label);
    refresh();
  });
  ctx.tools.events.on("activeChanged", ({ tool }) => {
    refresh();
    shell.setDrawerOpen(tool?.id === "place");
    if (tool?.hint) ctx.ui.setStatus(tool.hint);
  });

  // Grid <-> free placement toggle (P once the place tool is active).
  const placeTool = () =>
    ctx.tools.all.find((t) => t.id === "place") as
      | { mode: "grid" | "free"; toggleMode(): void }
      | undefined;
  const modeBtn = railButton("gridmode", "Grid place", "P", () => {
    if (ctx.tools.activeTool?.id !== "place") ctx.tools.setActive("place");
    else placeTool()?.toggleMode();
  });
  const refreshModeBtn = () => {
    const mode = placeTool()?.mode ?? "grid";
    clear(modeBtn);
    modeBtn.append(
      icon(mode === "grid" ? "gridmode" : "freemode"),
      el("span", { class: "tip" },
        mode === "grid" ? "Grid place — switch to free" : "Free place — switch to grid",
        el("b", {}, " P"),
      ),
    );
    modeBtn.classList.toggle("active", ctx.tools.activeTool?.id === "place");
  };
  ctx.events.on("placeModeChanged", refreshModeBtn);
  ctx.tools.events.on("activeChanged", refreshModeBtn);
  shell.rail.append(modeBtn);
  refreshModeBtn();

  shell.rail.append(el("div", { class: "rail-div" }));

  // Map lifecycle quick actions (browser above TMX, per the flows).
  shell.rail.append(
    railButton("folder", "Your tracks", null, () => openMapBrowser(ctx)),
    railButton("globe", "Open from TMX", null, () => openTmxDialog(ctx)),
    railButton("import", "Import JSON", null, () => importJsonFlow(ctx)),
    railButton("export", "Export JSON", null, () => exportJsonFlow(ctx)),
  );

  // Custom texture pack (mod) toggle: downloads the map's pack on first
  // use (spinner while it fetches); right-click / no-pack maps get the
  // library picker so any downloaded mod can be applied to any map.
  let modBusy = false;
  const modBtn = el("button", { class: "tbtn mod-btn" });
  const refreshModBtn = () => {
    if (modBusy) return;
    clear(modBtn);
    const on = !!ctx.document.activeMod;
    modBtn.append(
      icon("paint"),
      el("span", { class: "tip" },
        on ? "Texture pack on — click to turn off" : "Texture pack (downloads on first use)"),
    );
    modBtn.classList.toggle("active", on);
  };
  const runMod = (action: () => Promise<void>) => {
    if (modBusy) return;
    modBusy = true;
    clear(modBtn);
    modBtn.append(icon("spinner"), el("span", { class: "tip" }, "Downloading texture pack…"));
    modBtn.classList.add("busy");
    void action()
      .catch((err) => ctx.ui.setStatus(`Texture pack failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => {
        modBusy = false;
        modBtn.classList.remove("busy");
        refreshModBtn();
      });
  };
  modBtn.addEventListener("click", () => runMod(() => toggleMod(ctx)));
  modBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    runMod(() => openModPicker(ctx));
  });
  ctx.document.events.on("mapChanged", refreshModBtn);
  ctx.document.events.on("reset", refreshModBtn);
  shell.rail.append(modBtn);
  refreshModBtn();

  // Global settings pinned to the rail bottom: game-asset management
  // (re-import / relocate / wipe — the same dialog as first-run setup,
  // but closable) and the map settings gear.
  shell.rail.append(
    el("div", { class: "rail-spacer" }),
    railButton("assets", "Game assets", null, () => {
      void fetchSetupStatus().then((s) => {
        if (s) openSetupDialog(s, { locked: false });
        else ctx.ui.setStatus("Setup bridge unavailable (dev server?)");
      });
    }),
    railButton("gear", "Map settings", null, () => openSettingsDialog(ctx)),
  );

  // Paint swatch overlay (shows while the paint tool is active).
  const viewportWrap = shell.viewportCorner.parentElement;
  if (viewportWrap) mountPaintSwatch(ctx, viewportWrap);

  // Mood switcher in the viewport's top-right corner: click cycles
  // sunrise → day → sunset → night; the icon shows the current mood.
  const moodBtn = el("button", { class: "tbtn mood-btn" });
  const refreshMood = () => {
    clear(moodBtn);
    moodBtn.append(
      icon(MOOD_ICONS[ctx.document.mood]),
      el("span", { class: "tip" }, `Mood: ${ctx.document.mood} — click to change`),
    );
  };
  moodBtn.addEventListener("click", () => {
    const next = MOODS[(MOODS.indexOf(ctx.document.mood) + 1) % MOODS.length];
    ctx.document.setMood(next);
  });
  ctx.document.events.on("mapChanged", refreshMood);
  refreshMood();
  shell.viewportCorner.append(moodBtn);

  // Undo/redo live at the right end of the status bar (style guide §5.1).
  shell.statusActions.append(
    railButton("undo", "Undo", "Ctrl+Z", () => ctx.history.undo()),
    railButton("redo", "Redo", "Ctrl+Y", () => ctx.history.redo()),
  );

  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      ctx.history.undo();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      ctx.history.redo();
    }
  });

  refresh();
  shell.setDrawerOpen(ctx.tools.activeTool?.id === "place");
}

/** Map settings: name, base (decoration + size + type), mood. Applies live. */
function openSettingsDialog(ctx: EditorContext): void {
  const doc = ctx.document;

  const nameInput = el("input", { class: "input", type: "text", value: doc.name });
  nameInput.addEventListener("change", () => {
    doc.name = nameInput.value.trim() || doc.name;
  });

  const bases = baseListEl(
    (base) =>
      base.decoration === doc.decorationBase && base.size.every((v, i) => v === doc.size[i]),
    (base) => {
      doc.setMapBase(base);
      ctx.ui.setStatus(`Map base: ${base.label} (${base.note ?? base.type})`);
    },
  );
  const moods = moodRowEl((m) => m === doc.mood, (m) => doc.setMood(m));

  const content = el("div", { class: "settings-dialog" },
    el("div", { class: "field" }, el("label", {}, "Map name"), nameInput),
    el("div", { class: "field" }, el("label", {}, "Map base"), bases.root),
    el("div", { class: "field" }, el("label", {}, "Mood"), moods.root),
    el("p", { class: "hint" },
      "Base and mood apply in the editor and export with the map JSON. " +
      "gbxbuild currently keeps its template's decoration — oversize bases need a matching base .Map.Gbx template (e.g. eyebo's No Stadium bases).",
    ),
  );

  openDialog({ title: "Map settings", content, width: 380 });
}
