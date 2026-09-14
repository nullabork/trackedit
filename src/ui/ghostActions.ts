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
export async function fetchTmxGhost(
  ctx: EditorContext, mapId: number, layerId: string,
  pick: { replayId?: number; source?: "map" } = {},
): Promise<string> {
  try {
    const q = pick.source === "map" ? "?source=map" : pick.replayId ? `?replay=${pick.replayId}` : "";
    const res = await fetch(`/api/tmx/ghost/${mapId}${q}`);
    const json = (await res.json()) as (DumpGhost & { error?: string });
    if (!res.ok || json.error) return `No TMX replay for #${mapId}${json.error ? `: ${json.error}` : ""}`;
    const layer = ctx.document.getLayer(layerId);
    if (!layer) return "Layer gone before the ghost arrived";
    // One line per layer: loading a replay replaces (hides) the previous one.
    ctx.document.mutUpdateLayer(layerId, { ghost: ghostToLayer(json) });
    void persistNow(ctx);
    const what = json.source === "map" ? "validation ghost" : "TMX replay";
    return `Ghost path: ${what}${json.nickname ? ` by ${json.nickname}` : ""}` +
      `${json.raceTimeMs ? ` (${fmt(json.raceTimeMs)})` : ""}, ${json.path.length} samples`;
  } catch (err) {
    return `Ghost fetch failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Remove the layer's ghost line. */
export function hideGhost(ctx: EditorContext, layerId: string): void {
  if (!ctx.document.getLayer(layerId)?.ghost) return;
  ctx.document.mutUpdateLayer(layerId, { ghost: undefined });
  void persistNow(ctx);
}

export interface TmxReplayInfo {
  replayId: number;
  time: number;
  driver: string;
  at: string;
  position: number | null;
}

/** The open TMX map's replays (those with a file), its author time and game uid. */
export async function listTmxReplays(mapId: number): Promise<{ authorTime: number; mapUid: string | null; replays: TmxReplayInfo[] }> {
  const res = await fetch(`/api/tmx/replays/${mapId}`);
  const json = (await res.json()) as { authorTime?: number; mapUid?: string | null; replays?: TmxReplayInfo[]; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { authorTime: json.authorTime ?? 0, mapUid: json.mapUid ?? null, replays: json.replays ?? [] };
}

export interface NadeoRecordInfo {
  accountId: string;
  name: string;
  position: number;
  time: number;
  zone: string;
}

/** Whether the dev server has a Nadeo account to talk to the record services. */
export async function nadeoConfigured(): Promise<boolean> {
  try {
    const res = await fetch("/api/nadeo/status");
    return res.ok && !!((await res.json()) as { configured?: boolean }).configured;
  } catch {
    return false;
  }
}

/** World top records for a map, as the in-game leaderboard lists them. */
export async function listNadeoRecords(mapUid: string, length = 50): Promise<NadeoRecordInfo[]> {
  const res = await fetch(`/api/nadeo/records/${encodeURIComponent(mapUid)}?length=${length}`);
  const json = (await res.json()) as { records?: NadeoRecordInfo[]; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.records ?? [];
}

/**
 * Fetch a Nadeo record's ghost onto a layer (replacing the layer's line).
 * Resolves to the status text; never throws.
 */
export async function fetchNadeoGhost(ctx: EditorContext, mapUid: string, layerId: string, rec: NadeoRecordInfo): Promise<string> {
  try {
    const res = await fetch(`/api/nadeo/ghost/${encodeURIComponent(mapUid)}?account=${encodeURIComponent(rec.accountId)}`);
    const json = (await res.json()) as (DumpGhost & { error?: string });
    if (!res.ok || json.error) return `No Nadeo ghost for that record${json.error ? `: ${json.error}` : ""}`;
    if (!ctx.document.getLayer(layerId)) return "Layer gone before the ghost arrived";
    ctx.document.mutUpdateLayer(layerId, {
      ghost: ghostToLayer({ ...json, source: "nadeo", nickname: json.nickname || rec.name, accountId: rec.accountId }),
    });
    void persistNow(ctx);
    return `Ghost path: Nadeo record #${rec.position} by ${rec.name}` +
      `${json.raceTimeMs ? ` (${fmt(json.raceTimeMs)})` : ""}, ${json.path.length} samples`;
  } catch (err) {
    return `Ghost fetch failed: ${err instanceof Error ? err.message : err}`;
  }
}

export const formatRaceTime = fmt;

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
