import type { EditorContext } from "@plugins/api";
import type { DumpGhost } from "@io/trackoJson";
import { ghostToLayer } from "@io/trackoJson";
import { persistNow } from "./session";

/** The TMX map id of the open document, if it came from TMX (`tmx-<id>`). */
export function tmxIdOf(ctx: EditorContext): number | null {
  const m = /^tmx-(\d+)$/.exec(ctx.document.id);
  return m ? Number(m[1]) : null;
}

const fmt = (ms: number) => {
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return m ? `${m}:${s}` : `${s}s`;
};

/**
 * Fetch the driving path of the TMX replay closest to the map's author
 * time (dev-server bridge) and attach it to a layer. Resolves to the status
 * text; never throws — a missing replay is normal.
 */
export async function fetchTmxGhost(ctx: EditorContext, mapId: number, layerId: string): Promise<string> {
  try {
    const res = await fetch(`/api/tmx/ghost/${mapId}`);
    const json = (await res.json()) as (DumpGhost & { error?: string });
    if (!res.ok || json.error) return `No TMX replay for #${mapId}${json.error ? `: ${json.error}` : ""}`;
    const layer = ctx.document.getLayer(layerId);
    if (!layer) return "Layer gone before the ghost arrived";
    ctx.document.mutUpdateLayer(layerId, { ghost: ghostToLayer(json) });
    void persistNow(ctx);
    return `Ghost path: TMX replay${json.nickname ? ` by ${json.nickname}` : ""}` +
      `${json.raceTimeMs ? ` (${fmt(json.raceTimeMs)})` : ""}, ${json.path.length} samples`;
  } catch (err) {
    return `Ghost fetch failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Menu action: fetch a ghost for the open TMX map onto the active layer. */
export async function fetchGhostFlow(ctx: EditorContext): Promise<void> {
  const id = tmxIdOf(ctx);
  if (id === null) {
    ctx.ui.setStatus("Ghost paths come from TMX — open a map with File ▸ Open from TMX first.");
    return;
  }
  ctx.ui.setStatus(`Looking for a TMX replay of #${id}…`);
  ctx.ui.setStatus(await fetchTmxGhost(ctx, id, ctx.document.activeLayer.id));
}
