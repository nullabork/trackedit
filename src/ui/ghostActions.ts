import type { EditorContext } from "@plugins/api";
import type { GhostPath } from "@core/layer";
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
export const formatRaceTime = fmt;

// --- lines on a layer -------------------------------------------------------

/** Add (or replace, by key) a line on a layer. */
export function addGhost(ctx: EditorContext, layerId: string, ghost: GhostPath): void {
  const layer = ctx.document.getLayer(layerId);
  if (!layer) return;
  const ghosts = [...layer.ghosts.filter((g) => g.key !== ghost.key), ghost];
  ctx.document.mutUpdateLayer(layerId, { ghosts });
  void persistNow(ctx);
}

/** Remove one line by key. */
export function removeGhost(ctx: EditorContext, layerId: string, key: string): void {
  const layer = ctx.document.getLayer(layerId);
  if (!layer || !layer.ghosts.some((g) => g.key === key)) return;
  ctx.document.mutUpdateLayer(layerId, { ghosts: layer.ghosts.filter((g) => g.key !== key) });
  void persistNow(ctx);
}

/** Remove every line on a layer. */
export function clearGhosts(ctx: EditorContext, layerId: string): void {
  const layer = ctx.document.getLayer(layerId);
  if (!layer?.ghosts.length) return;
  ctx.document.mutUpdateLayer(layerId, { ghosts: [] });
  void persistNow(ctx);
}

/** Keys of the lines a layer shows. */
export function activeGhostKeys(ctx: EditorContext, layerId: string): Set<string> {
  return new Set((ctx.document.getLayer(layerId)?.ghosts ?? []).map((g) => g.key));
}

// --- TMX ------------------------------------------------------------------

export interface TmxReplayInfo {
  replayId: number;
  time: number;
  driver: string;
  at: string;
  position: number | null;
}

export interface TmxMapInfo {
  mapId: number;
  name: string;
  mapUid: string | null;
  onlineMapId: string | null;
  uploader: { name: string; userId: number | null };
  authors: { name: string; userId: number | null; role: string }[];
  medals: { author: number; gold: number; silver: number; bronze: number };
  awardCount: number;
  replayCount: number;
  downloadCount: number;
  commentCount: number;
  uploadedAt: string | null;
  updatedAt: string | null;
  hasGhostBlocks: boolean;
  tags: string[];
  embeddedObjects: number;
  mapType: string;
}

/** The map's TMX card. */
export async function fetchTmxInfo(mapId: number): Promise<TmxMapInfo> {
  const res = await fetch(`/api/tmx/info/${mapId}`);
  const json = (await res.json()) as TmxMapInfo & { error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** The open TMX map's replays (those with a file), its author time and game uid. */
export async function listTmxReplays(mapId: number): Promise<{ authorTime: number; mapUid: string | null; replays: TmxReplayInfo[] }> {
  const res = await fetch(`/api/tmx/replays/${mapId}`);
  const json = (await res.json()) as { authorTime?: number; mapUid?: string | null; replays?: TmxReplayInfo[]; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { authorTime: json.authorTime ?? 0, mapUid: json.mapUid ?? null, replays: json.replays ?? [] };
}

/**
 * Fetch a TMX line onto a layer: a specific replay, the map's own validation
 * ghost (`source: "map"`), or with no pick the replay closest to the author
 * time. Resolves to the status text; never throws — a missing replay is
 * normal.
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
    if (!ctx.document.getLayer(layerId)) return "Layer gone before the ghost arrived";
    addGhost(ctx, layerId, ghostToLayer(json));
    const what = json.source === "map" ? "validation ghost" : "TMX replay";
    return `Ghost path: ${what}${json.nickname ? ` by ${json.nickname}` : ""}` +
      `${json.raceTimeMs ? ` (${fmt(json.raceTimeMs)})` : ""}, ${json.path.length} samples`;
  } catch (err) {
    return `Ghost fetch failed: ${err instanceof Error ? err.message : err}`;
  }
}

// --- Nadeo ----------------------------------------------------------------

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
export async function listNadeoRecords(mapUid: string, length = 10): Promise<NadeoRecordInfo[]> {
  const res = await fetch(`/api/nadeo/records/${encodeURIComponent(mapUid)}?length=${length}`);
  const json = (await res.json()) as { records?: NadeoRecordInfo[]; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.records ?? [];
}

/** How many players hold a record on the map (null when Nadeo is not configured). */
export async function fetchNadeoFinishes(mapUid: string): Promise<number | null> {
  try {
    const res = await fetch(`/api/nadeo/finishes/${encodeURIComponent(mapUid)}`);
    if (!res.ok) return null;
    return ((await res.json()) as { finishes?: number }).finishes ?? null;
  } catch {
    return null;
  }
}

/** Fetch a Nadeo record's ghost onto a layer. Resolves to the status text; never throws. */
export async function fetchNadeoGhost(ctx: EditorContext, mapUid: string, layerId: string, rec: NadeoRecordInfo): Promise<string> {
  try {
    const res = await fetch(`/api/nadeo/ghost/${encodeURIComponent(mapUid)}?account=${encodeURIComponent(rec.accountId)}`);
    const json = (await res.json()) as (DumpGhost & { error?: string });
    if (!res.ok || json.error) return `No Nadeo ghost for that record${json.error ? `: ${json.error}` : ""}`;
    if (!ctx.document.getLayer(layerId)) return "Layer gone before the ghost arrived";
    addGhost(ctx, layerId, ghostToLayer({ ...json, source: "nadeo", nickname: json.nickname || rec.name, accountId: rec.accountId }));
    return `Ghost path: Nadeo record #${rec.position} by ${rec.name}` +
      `${json.raceTimeMs ? ` (${fmt(json.raceTimeMs)})` : ""}, ${json.path.length} samples`;
  } catch (err) {
    return `Ghost fetch failed: ${err instanceof Error ? err.message : err}`;
  }
}
