import type { EditorContext } from "@plugins/api";
import { importDump, exportDump } from "@io/trackoJson";
import type { MapDump } from "@io/trackoJson";
import { newId } from "@core/math";
import { el } from "./dom";
import { confirmDialog } from "./dialog";
import { openNewMapDialog } from "./NewMapDialog";
import { persistNow, session } from "./session";

/** Shared map lifecycle actions (used by the menu bar and the tool rail). */

export function importJsonFlow(ctx: EditorContext): void {
  const input = el("input", { type: "file", accept: ".json" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const dump = JSON.parse(await file.text()) as MapDump;
      const { layers, stats, name, decoration, modUrl } = importDump(dump);
      ctx.document.id = newId("map");
      ctx.document.reset(layers, {
        name: name ?? file.name.replace(/\.json$/i, ""),
        decoration,
        modUrl,
      });
      session.ready = true;
      void persistNow(ctx);
      ctx.ui.setStatus(
        `Imported ${stats.gridBlocks} blocks, ${stats.freeBlocks} free blocks, ` +
        `${stats.items} items (${stats.clipsSkipped} clips skipped)`,
      );
    } catch (err) {
      ctx.ui.setStatus(`Import failed: ${err instanceof Error ? err.message : err}`);
    }
  });
  input.click();
}

export function exportJsonFlow(ctx: EditorContext): void {
  const dump = exportDump(ctx.document);
  const blob = new Blob([JSON.stringify(dump, null, 1)], { type: "application/json" });
  const a = el("a", {
    href: URL.createObjectURL(blob),
    download: `${ctx.document.name.replace(/[^\w-]+/g, "_") || "map"}.placements.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  ctx.ui.setStatus("Exported placements JSON — feed it to gbxbuild for a .Map.Gbx");
}

/** New map, guarding a non-empty current track (it is saved, then cleared). */
export async function newMapGuarded(ctx: EditorContext): Promise<void> {
  const hasContent = ctx.document.layers.some((l) => l.placements.size > 0);
  if (hasContent && session.ready) {
    await persistNow(ctx);
    const ok = await confirmDialog({
      title: "Clear current track?",
      message:
        `All track data has been saved — clear the current track "${ctx.document.name}"? ` +
        "You can get back to it any time from the map browser.",
      confirmLabel: "Clear & new",
    });
    if (!ok) return;
  }
  openNewMapDialog(ctx);
}

/** Duplicate the current track under a new identity. */
export async function cloneFlow(ctx: EditorContext): Promise<void> {
  await persistNow(ctx); // keep the original safe first
  ctx.document.id = newId("map");
  ctx.document.name = `${ctx.document.name} copy`;
  session.ready = true;
  await persistNow(ctx);
  ctx.ui.setStatus(`Cloned as "${ctx.document.name}"`);
}
