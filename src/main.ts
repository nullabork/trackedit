/**
 * Composition root — the only file that knows every concrete class. Wires
 * core, render, tools and UI together, then hands the assembled EditorContext
 * to plugins (built-ins included).
 */

import { MapDocument } from "@core/document";
import { History } from "@core/commands";
import { BlockCatalog } from "@core/catalog";
import type { CatalogJson } from "@core/catalog";
import { SelectionModel } from "@core/selection";
import { Emitter } from "@core/events";
import { InputEngine } from "@input/InputEngine";
import { SceneView } from "@render/SceneView";
import { DocumentRenderer } from "@render/DocumentRenderer";
import { PlaceholderProvider } from "@render/PlaceholderProvider";
import { MeshProvider } from "@render/MeshProvider";
import { ToolManager } from "@tools/ToolManager";
import { Shell } from "@ui/Shell";
import { buildToolRail } from "@ui/ToolRail";
import { buildMenuBar } from "@ui/MenuBar";
import { openMapBrowser } from "@ui/MapBrowserDialog";
import { fetchSetupStatus, openSetupDialog, setupIncomplete } from "@ui/SetupDialog";
import { applyStored, persistNow, saveCamera, session } from "@ui/session";
import { applyModBySlug } from "@ui/mods";
import { getCurrentId, loadMap } from "@io/mapStore";
import type { AppEvents, EditorContext } from "@plugins/api";
import { PluginHost } from "@plugins/api";
import { builtinPlugins } from "@plugins/builtin";

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app missing");

  const catalogJson = (await (await fetch("catalog.json")).json()) as CatalogJson;
  const catalog = BlockCatalog.fromJson(catalogJson);

  const document_ = new MapDocument();
  const history = new History(document_);
  const events = new Emitter<AppEvents>();
  const shell = new Shell(root);
  const view = new SceneView(shell.canvas);
  const geometry = new MeshProvider(new PlaceholderProvider());
  const hasMeshes = await geometry.init();
  geometry.cameraPos = () => view.camera.position;
  catalog.applySizes(geometry.sizes);
  const renderer = new DocumentRenderer(document_, view, catalog, geometry);
  geometry.onLoaded = (blockName) => {
    renderer.refreshBlock(blockName);
    events.emit("geometryLoaded", { name: blockName });
  };
  const tools = new ToolManager(document_, view, renderer);
  const selection = new SelectionModel();
  const ctx: EditorContext = {
    document: document_,
    history,
    catalog,
    selection,
    view,
    renderer,
    geometry,
    tools,
    ui: shell,
    events,
  };

  // Sequence shortcuts (c/t/r/s…) get first refusal on all raw input.
  tools.setInterceptor(new InputEngine(ctx));

  // Map base / mood drive the grid size and viewport ambience.
  const applyMap = () => {
    view.setMapSize(document_.size);
    view.setAmbience(document_.mood, document_.baseType);
  };
  document_.events.on("mapChanged", applyMap);
  applyMap();

  const plugins = new PluginHost(ctx);
  for (const plugin of builtinPlugins) plugins.use(plugin);
  buildToolRail(ctx, shell);
  buildMenuBar(ctx, shell.menubar);

  // Autosave: any edit persists the current track (debounced; only once a
  // real track is open — see ui/session.ts).
  let saveTimer: number | undefined;
  const queueSave = () => {
    if (!session.ready) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void persistNow(ctx), 800);
  };
  history.events.on("changed", queueSave);
  document_.events.on("mapChanged", queueSave);
  document_.events.on("reset", queueSave);

  // Camera pose survives reloads (per map, localStorage).
  window.setInterval(() => saveCamera(ctx), 1000);
  window.addEventListener("beforeunload", () => saveCamera(ctx));

  // Re-apply (or clear) the map's active texture pack whenever a map opens.
  document_.events.on("reset", () => {
    void applyModBySlug(ctx, document_.activeMod).catch(() => {});
  });

  // Restore the last-edited track, or offer the map browser.
  console.log("[boot] before store restore");
  const currentId = getCurrentId();
  const stored = currentId ? await loadMap(currentId).catch(() => null) : null;
  console.log("[boot] store loaded", !!stored);
  // First run: no local game assets yet (they never ship with the repo) —
  // the mandatory setup dialog walks through pointing at Openplanet +
  // extracting + importing, and can't be dismissed until that's done
  // ("Start editing" then reloads into the normal flow).
  const setupStatus = await fetchSetupStatus();
  const needsSetup = setupIncomplete(setupStatus);
  if (stored) applyStored(ctx, stored);
  else if (!needsSetup) openMapBrowser(ctx);
  if (needsSetup) openSetupDialog(setupStatus!);
  console.log("[boot] complete");

  shell.setStatus(
    `Ready — ${catalog.defs.length} catalog entries, ` +
    (hasMeshes
      ? "real meshes enabled."
      : "placeholder boxes (run tools/meshdump to extract real meshes)."),
  );

  // Handy for debugging and for user scripts in the console.
  const io = await import("@io/trackoJson");
  (window as unknown as { trackedit: unknown }).trackedit = { ...ctx, io };
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f66;padding:2em">${err?.stack ?? err}</pre>`;
});
