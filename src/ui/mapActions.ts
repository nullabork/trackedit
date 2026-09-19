import { offerModShare, type SavedSunMod } from "./ModShareDialog";
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
  const dump = exportDump(ctx.document, undefined, ctx.waypoints);
  const blob = new Blob([JSON.stringify(dump, null, 1)], { type: "application/json" });
  const a = el("a", {
    href: URL.createObjectURL(blob),
    download: `${ctx.document.name.replace(/[^\w-]+/g, "_") || "map"}.placements.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  ctx.ui.setStatus("Exported placements JSON — feed it to gbxbuild for a .Map.Gbx");
}

/**
 * Save the track as a real .Map.Gbx in the game's Maps/Trackedit folder
 * (dev-server bridge -> `meshdump build`). Shadows are not computed: the
 * game does that (editor, or the Batch Compute Shadows Openplanet plugin).
 */
export async function saveToGameFlow(ctx: EditorContext): Promise<void> {
  ctx.ui.setStatus("Writing the map file…");
  try {
    const tmx = /^tmx-(\d+)$/.exec(ctx.document.id);
    const res = await fetch("/api/game/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dump: exportDump(ctx.document, undefined, ctx.waypoints, true), docId: ctx.document.id, tmxId: tmx ? Number(tmx[1]) : null, atmosphere: ctx.document.atmosphere }),
    });
    const json = (await res.json()) as { sunMod?: SavedSunMod | null; notes?: string[]; path?: string; blocks?: number; items?: number; blocksBuilt?: number; itemsBuilt?: number; blocksMoved?: number; itemsMoved?: number; blocksRemoved?: number; itemsRemoved?: number; recoloured?: number; lightmapKept?: boolean; itemsSkipped?: number; error?: string };
    if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
    const added = (json.blocksBuilt ?? 0) + (json.itemsBuilt ?? 0);
    const moved = (json.blocksMoved ?? 0) + (json.itemsMoved ?? 0);
    const removed = (json.blocksRemoved ?? 0) + (json.itemsRemoved ?? 0);
    const edited = added + moved + removed + (json.recoloured ?? 0);
    ctx.ui.setStatus(
      `Saved ${json.path} — ${json.blocks} blocks, ${json.items} items` +
      (edited ? ` — changes applied: ${added} added, ${moved} moved, ${removed} removed, ${json.recoloured ?? 0} recoloured; everything else is the original, untouched` : " — no changes: every block and item is the original") +
      (json.itemsSkipped ? `, ${json.itemsSkipped} items skipped (template has no item to model them on)` : "") +
      (json.lightmapKept ? ". The baked shadows were kept." : ". Shadows are not computed: open it in the game editor and compute them there.") +
      (json.notes?.length ? ` ${json.notes.join(" ")}` : ""));
    // A freshly written look is a local file: offer the upload-and-link step.
    if (json.sunMod && !json.sunMod.url && json.path) offerModShare(ctx, json.sunMod, json.path);
  } catch (err) {
    ctx.ui.setStatus(`Save to Trackmania failed: ${err instanceof Error ? err.message : err}`);
  }
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
