import type { EditorContext } from "@plugins/api";
import type { GhostPath } from "@core/layer";
import type { DumpGhost } from "@io/trackoJson";
import { ghostToLayer } from "@io/trackoJson";
import { cacheGet, cachePut } from "@io/ghostCache";
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
  // A reloaded line keeps its place (so its hue) and its editor settings.
  const at = layer.ghosts.findIndex((g) => g.key === ghost.key);
  const old = layer.ghosts[at];
  const next = old ? { ...ghost, ...(old.visible !== undefined ? { visible: old.visible } : {}), ...(old.showNumbers !== undefined ? { showNumbers: old.showNumbers } : {}) } : ghost;
  const ghosts = old ? layer.ghosts.map((g, i) => (i === at ? next : g)) : [...layer.ghosts, next];
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

/** Change a line's editor settings (visibility, checkpoint numbers). */
export function updateGhost(ctx: EditorContext, layerId: string, key: string, patch: Partial<Pick<GhostPath, "visible" | "showNumbers" | "showAttempts" | "attemptOpacity">>): void {
  const layer = ctx.document.getLayer(layerId);
  if (!layer || !layer.ghosts.some((g) => g.key === key)) return;
  ctx.document.mutUpdateLayer(layerId, { ghosts: layer.ghosts.map((g) => (g.key === key ? { ...g, ...patch } : g)) });
  void persistNow(ctx);
}

/**
 * Fetch a loaded line again from where it came from. Lines saved before the
 * ghost's checkpoint times were kept get them this way. Resolves to status text.
 */
export async function reloadGhost(ctx: EditorContext, layerId: string, ghost: GhostPath): Promise<string> {
  if (ghost.source === "nadeo") {
    if (!ctx.document.mapUid || !ghost.accountId) return "This record cannot be fetched again: the map's uid is unknown.";
    return fetchNadeoGhost(ctx, ctx.document.mapUid, layerId,
      { accountId: ghost.accountId, name: ghost.driver ?? ghost.label.replace(/^.* by /, ""), position: 0, time: ghost.timeMs ?? 0, zone: "" }, true);
  }
  const mapId = tmxIdOf(ctx);
  if (mapId === null) return "This line cannot be fetched again: the map did not come from TMX.";
  return fetchTmxGhost(ctx, mapId, layerId, ghost.source === "map" ? { source: "map", fresh: true } : { replayId: ghost.replayId, fresh: true });
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
  pick: { replayId?: number; source?: "map"; fresh?: boolean } = {},
): Promise<string> {
  try {
    const q = pick.source === "map" ? "?source=map" : pick.replayId ? `?replay=${pick.replayId}` : "";
    // A replay file never changes; "closest to the author time" (no pick) can, so it is not cached.
    const cacheKey = pick.source === "map" ? `tmx:${mapId}:map` : pick.replayId ? `tmx:${mapId}:${pick.replayId}` : null;
    let json = (!pick.fresh && cacheKey ? (await cacheGet<DumpGhost>("lines", cacheKey))?.value : undefined) as (DumpGhost & { error?: string }) | undefined;
    if (!json) {
      const res = await fetch(`/api/tmx/ghost/${mapId}${q}`);
      json = (await res.json()) as (DumpGhost & { error?: string });
      if (!res.ok || json.error) return `No TMX replay for #${mapId}${json.error ? `: ${json.error}` : ""}`;
      if (cacheKey) void cachePut("lines", cacheKey, json);
    }
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

/**
 * World top records for a map, as the in-game leaderboard lists them. Served
 * from the browser cache unless `fresh` (the panel's refresh button); `at` is
 * when the list was fetched.
 */
export async function listNadeoRecords(mapUid: string, length = 10, fresh = false): Promise<{ records: NadeoRecordInfo[]; at: number; cached: boolean }> {
  const key = `nadeo:${mapUid}:top${length}`;
  if (!fresh) {
    const hit = await cacheGet<NadeoRecordInfo[]>("lists", key);
    if (hit) return { records: hit.value, at: hit.at, cached: true };
  }
  const res = await fetch(`/api/nadeo/records/${encodeURIComponent(mapUid)}?length=${length}`);
  const json = (await res.json()) as { records?: NadeoRecordInfo[]; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  void cachePut("lists", key, json.records ?? []);
  return { records: json.records ?? [], at: Date.now(), cached: false };
}

/**
 * Records on a map by players whose name starts with (or, for names already
 * seen, contains) `name`. Nadeo has no name search; the dev server asks
 * trackmania.io for the players and Nadeo for their records. Not cached:
 * a search is asked for because something changed.
 */
export async function searchNadeoRecords(mapUid: string, name: string): Promise<{ records: NadeoRecordInfo[]; matched: number; via: string[] }> {
  const res = await fetch(`/api/nadeo/search/${encodeURIComponent(mapUid)}?name=${encodeURIComponent(name)}`);
  const json = (await res.json()) as { records?: NadeoRecordInfo[]; matched?: number; via?: string[]; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { records: json.records ?? [], matched: json.matched ?? 0, via: json.via ?? [] };
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
export async function fetchNadeoGhost(ctx: EditorContext, mapUid: string, layerId: string, rec: NadeoRecordInfo, fresh = false): Promise<string> {
  try {
    // Keyed by the record's time: a new personal best is another line. Without a time
    // (a reload of an old saved line) nothing identifies the run, so it is always fetched.
    const cacheKey = rec.time ? `nadeo:${mapUid}:${rec.accountId}:${rec.time}` : null;
    let json = (!fresh && cacheKey ? (await cacheGet<DumpGhost>("lines", cacheKey))?.value : undefined) as (DumpGhost & { error?: string }) | undefined;
    if (!json) {
      const res = await fetch(`/api/nadeo/ghost/${encodeURIComponent(mapUid)}?account=${encodeURIComponent(rec.accountId)}`);
      json = (await res.json()) as (DumpGhost & { error?: string });
      if (!res.ok || json.error) return `No Nadeo ghost for that record${json.error ? `: ${json.error}` : ""}`;
      if (json.raceTimeMs) void cachePut("lines", `nadeo:${mapUid}:${rec.accountId}:${json.raceTimeMs}`, json);
    }
    if (!ctx.document.getLayer(layerId)) return "Layer gone before the ghost arrived";
    addGhost(ctx, layerId, ghostToLayer({ ...json, source: "nadeo", nickname: json.nickname || rec.name, accountId: rec.accountId }));
    return `Ghost path: Nadeo record${rec.position ? ` #${rec.position}` : ""} by ${rec.name}` +
      `${json.raceTimeMs ? ` (${fmt(json.raceTimeMs)})` : ""}, ${json.path.length} samples`;
  } catch (err) {
    return `Ghost fetch failed: ${err instanceof Error ? err.message : err}`;
  }
}
