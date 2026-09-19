import { offerModShare, type SavedSunMod } from "./ModShareDialog";
import type { EditorContext } from "@plugins/api";
import { importDump, exportDump } from "@io/trackoJson";
import type { MapDump } from "@io/trackoJson";
import { newId } from "@core/math";
import { el } from "./dom";
import { confirmDialog, openDialog } from "./dialog";
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
    const json = (await res.json()) as { sunMod?: SavedSunMod | null; notes?: string[]; path?: string; blocks?: number; items?: number; blocksBuilt?: number; itemsBuilt?: number; blocksMoved?: number; itemsMoved?: number; blocksRemoved?: number; itemsRemoved?: number; recoloured?: number; lightmapKept?: boolean; lightmapStale?: boolean; itemsSkipped?: number; error?: string };
    if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
    const added = (json.blocksBuilt ?? 0) + (json.itemsBuilt ?? 0);
    const moved = (json.blocksMoved ?? 0) + (json.itemsMoved ?? 0);
    const removed = (json.blocksRemoved ?? 0) + (json.itemsRemoved ?? 0);
    const edited = added + moved + removed + (json.recoloured ?? 0);
    ctx.ui.setStatus(
      `Saved ${json.path} — ${json.blocks} blocks, ${json.items} items` +
      (edited ? ` — changes applied: ${added} added, ${moved} moved, ${removed} removed, ${json.recoloured ?? 0} recoloured; everything else is the original, untouched` : " — no changes: every block and item is the original") +
      (json.itemsSkipped ? `, ${json.itemsSkipped} items skipped (template has no item to model them on)` : "") +
      (json.lightmapStale ? ". The original baked shadows were kept: only what you changed lacks them — compute shadows in the game when you want it clean."
        : json.lightmapKept ? ". The baked shadows were kept."
        : ". Shadows are not computed (the light changed, or the original had none): compute them in the game editor.") +
      (json.notes?.length ? ` ${json.notes.join(" ")}` : ""));
    // A freshly written look is a local file: offer the upload-and-link step.
    if (json.sunMod && !json.sunMod.url && json.path) offerModShare(ctx, json.sunMod, json.path);
  } catch (err) {
    ctx.ui.setStatus(`Save to Trackmania failed: ${err instanceof Error ? err.message : err}`);
  }
}

interface VariantReport {
  error?: string;
  blocks: number;
  custom: number;
  undefinedBlocks: number;
  outOfRange: number;
  notExtracted: number;
  byVariant: Record<string, number>;
  perBlock: Record<string, { used: Record<string, number>; airVariants: string[]; groundVariants: string[]; notExtracted: string[] }>;
}

/**
 * Check every block of the open TMX map against the game's definitions: the
 * variant each one names (air/ground + index, from the map file's flags) has
 * to exist for that block, and the mesh extraction has to know it.
 */
export async function verifyVariantsFlow(ctx: EditorContext): Promise<void> {
  const tmx = /^tmx-(\d+)$/.exec(ctx.document.id);
  if (!tmx) {
    ctx.ui.setStatus("Verify block variants reads the map's original file: open the map from TMX first.");
    return;
  }
  ctx.ui.setStatus("Checking every block against the game's definitions…");
  try {
    const r = (await (await fetch(`/api/game/verify?tmx=${tmx[1]}`)).json()) as VariantReport;
    if (r.error) throw new Error(r.error);
    const checked = r.blocks - r.custom - r.undefinedBlocks;
    const variants = Object.entries(r.byVariant).sort(([a], [b]) => a.localeCompare(b));
    const stale = Object.entries(r.perBlock).filter(([, b]) => b.notExtracted.length);
    const table = el("table", { class: "tmx-stats" },
      ...variants.map(([name, n]) => el("tr", {}, el("td", {}, name), el("td", {}, String(n)))));
    const content = el("div", { class: "settings-dialog" },
      el("p", { class: "dialog-message" },
        `${checked} blocks checked (${r.custom} custom blocks and ${r.undefinedBlocks} without a readable definition skipped). ` +
        (r.outOfRange === 0
          ? "Every one names a variant its block really has."
          : `${r.outOfRange} name a variant their block does not have — the flags are being read wrong for them.`)),
      table,
      el("p", { class: r.notExtracted ? "dialog-message" : "hint" },
        r.notExtracted === 0
          ? "The mesh extraction knows every variant this map uses."
          : `${r.notExtracted} blocks use a variant the mesh extraction does not know yet, so they show their base look: ` +
            `${stale.slice(0, 12).map(([name, b]) => `${name} (${b.notExtracted.join(", ")})`).join(", ")}${stale.length > 12 ? "…" : ""}. ` +
            "Re-import the game assets (tool rail ▸ Game assets) to extract them."),
    );
    openDialog({ title: "Block variants", content, width: 420 });
    ctx.ui.setStatus(`Block variants: ${checked} checked, ${r.outOfRange} wrong, ${r.notExtracted} not extracted yet.`);
  } catch (err) {
    ctx.ui.setStatus(`Variant check failed: ${err instanceof Error ? err.message : err}`);
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
