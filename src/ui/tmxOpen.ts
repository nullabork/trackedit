import type { EditorContext } from "@plugins/api";
import { importDump } from "@io/trackoJson";
import type { MapDump } from "@io/trackoJson";
import { loadMap } from "@io/mapStore";
import { applyStored, persistNow, session } from "./session";
import { fetchTmxGhost } from "./ghostActions";

/** Import a converted map as the open document, under the given document id. */
async function openDump(ctx: EditorContext, dump: MapDump, docId: string, fallbackName: string, origin: string): Promise<string> {
  // The bridge may have extracted the map's embedded custom assets into the
  // mesh library — pick up the fresh index before rendering.
  await (ctx.geometry as { init?: () => Promise<boolean> }).init?.();
  const imported = importDump(dump);
  // The track carries its origin's identity into the local database.
  ctx.document.id = docId;
  ctx.document.reset(imported.layers, {
    name: dump.mapName ?? fallbackName,
    decoration: dump.decoration,
    mapUid: dump.mapUid ?? null,
    validationGhost: !!dump.ghost?.path?.length,
    colorPalette: dump.colorPalette,
    modUrl: imported.modUrl,
  });
  session.ready = true;
  void persistNow(ctx);
  return `Opened ${dump.mapName ?? fallbackName}: ${imported.stats.gridBlocks + imported.stats.freeBlocks} blocks, ` +
    `${imported.stats.items} items (${origin})`;
}

const fetchDump = async (url: string): Promise<MapDump> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return (await res.json()) as MapDump;
};

/**
 * Open a TMX map by id: download + convert through the dev-server bridge,
 * import it as a layer, persist, then draw a ghost line — the map's own
 * validation ghost when it has one, else the TMX replay nearest the author
 * time (fetched in the background). Shared by the TMX dialog and the debug
 * bridge (`?action=tmx&uid=<MapId>`).
 */
export async function openTmxMap(ctx: EditorContext, mapId: number, fallbackName = `TMX #${mapId}`): Promise<string> {
  const dump = await fetchDump(`/api/tmx/load/${mapId}`);
  const summary = await openDump(ctx, dump, `tmx-${mapId}`, fallbackName, `TMX #${mapId}`);
  ctx.ui.setStatus(summary);
  const layer = ctx.document.layers[0];
  if (layer.ghosts.length) ctx.ui.setStatus(`${summary} — ghost: ${layer.ghosts[0].label}`);
  else void fetchTmxGhost(ctx, mapId, layer.id).then((msg) => ctx.ui.setStatus(msg));
  return summary;
}

/** What Nadeo (and TMX) know of a map uid — `/api/nadeo/map/:uid`. */
export interface NadeoMapInfo {
  mapUid: string;
  name: string;
  authorAccountId: string;
  authorTime: number;
  goldTime: number;
  tmxId: number | null;
}

export async function fetchNadeoMapInfo(mapUid: string): Promise<NadeoMapInfo> {
  const res = await fetch(`/api/nadeo/map/${encodeURIComponent(mapUid)}`);
  const json = (await res.json().catch(() => null)) as (NadeoMapInfo & { error?: string }) | null;
  if (!res.ok || !json || json.error) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json;
}

/**
 * Open a map by its GAME uid — the map a club room is playing. A uid names one
 * exact file, so:
 *  - a track already in the local database under that identity opens from there,
 *    with its lines and edits (a server cycling its playlist must never overwrite them);
 *  - else, when TMX has the same uid, it opens as that TMX map (card, replays);
 *  - else the file comes from Nadeo's own storage, as `nadeo-<uid>`.
 */
export async function openMapByUid(ctx: EditorContext, mapUid: string): Promise<string> {
  const info = await fetchNadeoMapInfo(mapUid);
  const docId = info.tmxId !== null ? `tmx-${info.tmxId}` : `nadeo-${mapUid}`;
  const stored = await loadMap(docId).catch(() => null);
  if (stored && stored.mapUid === mapUid) {
    if (session.ready) await persistNow(ctx);
    applyStored(ctx, stored);
    return `Opened ${stored.name} from your tracks`;
  }
  if (session.ready) await persistNow(ctx);
  if (info.tmxId !== null) return openTmxMap(ctx, info.tmxId, info.name);
  const summary = await openDump(ctx, await fetchDump(`/api/nadeo/map/${encodeURIComponent(mapUid)}?load=1`), docId, info.name, "from Nadeo, not on TMX");
  ctx.ui.setStatus(summary);
  return summary;
}
