import type { EditorContext } from "@plugins/api";
import { importDump } from "@io/trackoJson";
import type { MapDump } from "@io/trackoJson";
import { persistNow, session } from "./session";
import { fetchTmxGhost } from "./ghostActions";

/**
 * Open a TMX map by id: download + convert through the dev-server bridge,
 * import it as a layer, persist, then draw a ghost line — the map's own
 * validation ghost when it has one, else the TMX replay nearest the author
 * time (fetched in the background). Shared by the TMX dialog and the debug
 * bridge (`?action=tmx&uid=<MapId>`).
 */
export async function openTmxMap(ctx: EditorContext, mapId: number, fallbackName = `TMX #${mapId}`): Promise<string> {
  const res = await fetch(`/api/tmx/load/${mapId}`);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  const dump = (await res.json()) as MapDump;
  // The bridge may have extracted the map's embedded custom assets into the
  // mesh library — pick up the fresh index before rendering.
  await (ctx.geometry as { init?: () => Promise<boolean> }).init?.();
  const imported = importDump(dump);
  // TMX tracks carry their TMX identity into the local database.
  ctx.document.id = `tmx-${mapId}`;
  ctx.document.reset(imported.layers, {
    name: dump.mapName ?? fallbackName,
    decoration: dump.decoration,
    modUrl: imported.modUrl,
  });
  session.ready = true;
  void persistNow(ctx);
  const summary =
    `Opened ${dump.mapName ?? fallbackName}: ${imported.stats.gridBlocks + imported.stats.freeBlocks} blocks, ` +
    `${imported.stats.items} items (TMX #${mapId})`;
  ctx.ui.setStatus(summary);
  const layer = imported.layers[0];
  if (layer.ghost) ctx.ui.setStatus(`${summary} — ghost: ${layer.ghost.label}`);
  else void fetchTmxGhost(ctx, mapId, layer.id).then((msg) => ctx.ui.setStatus(msg));
  return summary;
}
