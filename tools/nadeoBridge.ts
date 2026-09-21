import type { Plugin } from "vite";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MapLoader } from "./mapLoader";

/**
 * Dev-server bridge to Nadeo's record services — the leaderboard the game
 * shows in single player, and the ghost file behind each record.
 *
 *   GET /api/nadeo/status                       -> { configured }
 *   GET /api/nadeo/records/:mapUid?length=50    -> { records: [{ accountId, name, position, time, zone }] }
 *   GET /api/nadeo/ghost/:mapUid?account=<id>   -> the record's driving path (meshdump ghost JSON)
 *   GET /api/nadeo/finishes/:mapUid             -> { finishes } — how many players hold a world record (max 10000)
 *   GET /api/nadeo/search/:mapUid?name=<text>   -> { records, via } — records of players whose name contains the text
 *   GET /api/nadeo/rooms?name=<text>            -> { rooms, total } — club rooms ("servers") whose name contains the text, busiest first
 *   GET /api/nadeo/room/:clubId/:activityId     -> the room now: players, the map being played, its playlist
 *   GET /api/nadeo/map/:mapUid                  -> the map's name, author, medals and the TMX id when TMX has it
 *   GET /api/nadeo/map/:mapUid?load=1           -> downloads the map from Nadeo and returns the editor dump
 *
 * Nadeo requires authentication. A dedicated server account (free, created
 * at https://www.trackmania.com/player/dedicated-servers) goes in the
 * gitignored `.trackedit.local.json`:
 *
 *   { "nadeo": { "login": "...", "password": "...",
 *                "oauth": { "clientId": "...", "clientSecret": "..." } } }
 *
 * `oauth` is optional: display names moved to api.trackmania.com, which
 * needs an OAuth app (https://api.trackmania.com/manager). Without it the
 * list shows shortened account ids.
 */
export interface NadeoConfig {
  login?: string;
  password?: string;
  oauth?: { clientId?: string; clientSecret?: string };
}

export interface NadeoRecord {
  accountId: string;
  name: string;
  position: number;
  time: number;
  zone: string;
}

/** A club room — what the game lists as a server to join. */
export interface NadeoRoom {
  clubId: number;
  activityId: number;
  name: string;
  clubName: string;
  playerCount: number;
  maxPlayers: number;
  /** false: a player's own dedicated server — Nadeo does not know what it is playing. */
  nadeoHosted: boolean;
  /** The room's playlist (map uids). */
  maps: string[];
}

export interface NadeoRoomState extends NadeoRoom {
  /** The server is up. A Nadeo-hosted room shuts down when empty. */
  running: boolean;
  /** The map being played now; null when the server is off or is not Nadeo's. */
  currentMapUid: string | null;
  /** When this answer was fetched from Nadeo (ms) — answers are shared for ROOM_TTL_MS. */
  at: number;
}

export interface NadeoMapInfo {
  mapUid: string;
  name: string;
  authorAccountId: string;
  authorTime: number;
  goldTime: number;
  /** TrackmaniaExchange id when the same file (same uid) is on TMX, else null. */
  tmxId: number | null;
}

/**
 * Nadeo publishes no rate limit; the community guideline (webservices.openplanet.dev,
 * "Responsible usage") is about two requests a second for short bursts and LESS for
 * semi-live monitoring. A tracked room is polled every 15 s by the editor; whatever the
 * clients do, one room is asked of Nadeo at most this often (every tab shares the answer).
 */
const ROOM_TTL_MS = 10_000;

/** Trackmania text formatting ($fff, $o, $l[...]) off a name. */
export const stripFormat = (s: string | null | undefined): string =>
  (s ?? "").replace(/\$[lh]\[[^\]]*\]/gi, "").replace(/\$[0-9a-f]{3}/gi, "").replace(/\$[a-z<>$]/gi, "").trim();

const CORE = "https://prod.trackmania.core.nadeo.online";
const LIVE = "https://live-services.trackmania.nadeo.live";
const OAUTH = "https://api.trackmania.com/api";
/** Player search by partial name: Nadeo has none; trackmania.io (community API) does. */
const TMIO = "https://trackmania.io/api";
const USER_AGENT = "trackedit-dev / https://github.com/nullabork/trackedit";
/** Nadeo tokens last an hour; refresh a little early. */
const TOKEN_TTL_MS = 50 * 60_000;
/** Downloaded record files (small: tens of KB) — reused for names and lines. */
const CACHE_DIR = join(tmpdir(), "trackedit-nadeo-records");

/** A room's playlist: an array — or, rarely, an object keyed "0", "1", … (documented quirk). */
const mapList = (maps: unknown): string[] =>
  (Array.isArray(maps) ? maps : maps && typeof maps === "object" ? Object.values(maps) : []).filter((m): m is string => typeof m === "string");

/** A map opened from Nadeo (not on TMX) keeps its original here: the save-back template. */
export const nadeoTemplatePath = (mapUid: string): string =>
  join(process.cwd(), "maps", "gbx", `nadeo-${mapUid}.Map.Gbx`);

type Audience = "NadeoServices" | "NadeoLiveServices";

export class NadeoClient {
  private tokens = new Map<Audience, { token: string; at: number }>();
  private oauthToken: { token: string; at: number } | null = null;
  private names = new Map<string, string>();
  private mapIds = new Map<string, string>();

  constructor(private cfg: NadeoConfig, private meshdump: string) {}

  get configured(): boolean {
    return !!(this.cfg.login && this.cfg.password);
  }

  private async token(aud: Audience): Promise<string> {
    const cached = this.tokens.get(aud);
    if (cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
    const basic = Buffer.from(`${this.cfg.login}:${this.cfg.password}`).toString("base64");
    const res = await fetch(`${CORE}/v2/authentication/token/basic`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ audience: aud }),
    });
    if (!res.ok) throw new Error(`Nadeo login failed (${res.status}) — check nadeo.login/password in .trackedit.local.json`);
    const json = (await res.json()) as { accessToken?: string };
    if (!json.accessToken) throw new Error("Nadeo login returned no token");
    this.tokens.set(aud, { token: json.accessToken, at: Date.now() });
    return json.accessToken;
  }

  private async get<T>(aud: Audience, url: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `nadeo_v1 t=${await this.token(aud)}`, "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`Nadeo ${res.status} for ${url.replace(/\?.*$/, "")}`);
    return (await res.json()) as T;
  }

  /** World top records for a map, as the in-game leaderboard lists them. */
  async records(mapUid: string, length = 50): Promise<NadeoRecord[]> {
    type Top = { tops?: { top?: { accountId: string; position: number; score: number; zoneName?: string }[] }[] };
    const json = await this.get<Top>("NadeoLiveServices",
      `${LIVE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}/top?onlyWorld=true&length=${length}&offset=0`);
    const top = json.tops?.[0]?.top ?? [];
    const names = await this.displayNames(top.map((r) => r.accountId));
    const missing = top.map((r) => r.accountId).filter((id) => !names.has(id));
    if (missing.length) {
      for (const [id, name] of await this.namesFromRecordFiles(mapUid, missing)) names.set(id, name);
    }
    return top.map((r) => ({
      accountId: r.accountId,
      name: names.get(r.accountId) ?? r.accountId.slice(0, 8),
      position: r.position,
      time: r.score,
      zone: r.zoneName ?? "",
    }));
  }

  /** Display names through the OAuth API when configured, else nothing. */
  private async displayNames(accountIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const { clientId, clientSecret } = this.cfg.oauth ?? {};
    if (!clientId || !clientSecret) return out;
    const missing = accountIds.filter((id) => !this.names.has(id));
    try {
      if (missing.length) {
        if (!this.oauthToken || Date.now() - this.oauthToken.at > TOKEN_TTL_MS) {
          const res = await fetch(`${OAUTH}/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
            body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
          });
          const json = (await res.json()) as { access_token?: string };
          if (!json.access_token) throw new Error(`OAuth token ${res.status}`);
          this.oauthToken = { token: json.access_token, at: Date.now() };
        }
        for (let i = 0; i < missing.length; i += 50) {
          const q = missing.slice(i, i + 50).map((id) => `accountId[]=${encodeURIComponent(id)}`).join("&");
          const res = await fetch(`${OAUTH}/display-names?${q}`, {
            headers: { Authorization: `Bearer ${this.oauthToken.token}`, "User-Agent": USER_AGENT },
          });
          if (!res.ok) throw new Error(`display-names ${res.status}`);
          for (const [id, name] of Object.entries((await res.json()) as Record<string, string>)) this.names.set(id, name);
        }
      }
    } catch (err) {
      console.warn("[nadeo] display names unavailable:", err instanceof Error ? err.message : err);
    }
    for (const id of accountIds) {
      const n = this.names.get(id);
      if (n) out.set(id, n);
    }
    return out;
  }

  private finishes = new Map<string, { n: number; at: number }>();

  /**
   * How many accounts have a personal best on the map. The leaderboard has
   * no count endpoint, so binary-search the last non-empty offset (the API
   * serves offsets up to 10000).
   */
  async finishCount(mapUid: string): Promise<number> {
    const cached = this.finishes.get(mapUid);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.n;
    type Top = { tops?: { top?: unknown[] }[] };
    const has = async (offset: number) => {
      const json = await this.get<Top>("NadeoLiveServices",
        `${LIVE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}/top?onlyWorld=true&length=1&offset=${offset}`);
      return (json.tops?.[0]?.top?.length ?? 0) > 0;
    };
    let lo = 0, hi = 10000; // invariant: has(lo) unknown-but-assumed, !has(hi) or hi is the cap
    if (!(await has(0))) { this.finishes.set(mapUid, { n: 0, at: Date.now() }); return 0; }
    if (await has(hi)) { this.finishes.set(mapUid, { n: hi + 1, at: Date.now() }); return hi + 1; }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await has(mid)) lo = mid; else hi = mid;
    }
    this.finishes.set(mapUid, { n: lo + 1, at: Date.now() });
    return lo + 1;
  }

  /** Club rooms whose name contains the text (any club), busiest first — Nadeo's own order. */
  async searchRooms(name: string, length = 30): Promise<{ rooms: NadeoRoom[]; total: number }> {
    type Row = { clubId: number; activityId: number; name: string; clubName: string; nadeo: boolean; room?: { playerCount?: number; maxPlayers?: number; maps?: unknown } };
    // `name` is the filter (as on the club search); "nameFilter" and the like are silently ignored.
    const json = await this.get<{ clubRoomList?: Row[]; itemCount?: number }>("NadeoLiveServices",
      `${LIVE}/api/token/club/room?length=${length}&offset=0&name=${encodeURIComponent(name)}`);
    const rooms = (json.clubRoomList ?? []).map((r) => ({
      clubId: r.clubId,
      activityId: r.activityId,
      name: stripFormat(r.name),
      clubName: stripFormat(r.clubName),
      playerCount: r.room?.playerCount ?? 0,
      maxPlayers: r.room?.maxPlayers ?? 0,
      nadeoHosted: !!r.nadeo,
      maps: mapList(r.room?.maps),
    }));
    return { rooms, total: json.itemCount ?? rooms.length };
  }

  private roomStates = new Map<string, { state: Promise<NadeoRoomState>; at: number }>();

  /** A room now. One request to Nadeo per room per ROOM_TTL_MS, however many ask. */
  room(clubId: number, activityId: number): Promise<NadeoRoomState> {
    const key = `${clubId}/${activityId}`;
    const cached = this.roomStates.get(key);
    if (cached && Date.now() - cached.at < ROOM_TTL_MS) return cached.state;
    type Details = {
      name: string; clubName: string; nadeo: boolean;
      room?: { name?: string; playerCount?: number; maxPlayers?: number; maps?: unknown; serverInfo?: { currentMapUid?: string; playerCount?: number } | null };
    };
    const state = this.get<Details>("NadeoLiveServices", `${LIVE}/api/token/club/${clubId}/room/${activityId}`).then((d) => ({
      clubId,
      activityId,
      name: stripFormat(d.room?.name || d.name), // a player-hosted room's own name is ""
      clubName: stripFormat(d.clubName),
      playerCount: d.room?.serverInfo?.playerCount ?? d.room?.playerCount ?? 0,
      maxPlayers: d.room?.maxPlayers ?? 0,
      nadeoHosted: !!d.nadeo,
      maps: mapList(d.room?.maps),
      running: !!d.room?.serverInfo,
      currentMapUid: d.room?.serverInfo?.currentMapUid || null,
      at: Date.now(),
    }));
    this.roomStates.set(key, { state, at: Date.now() });
    // A failed answer is not worth sharing.
    state.catch(() => { if (this.roomStates.get(key)?.state === state) this.roomStates.delete(key); });
    return state;
  }

  private mapInfos = new Map<string, NadeoMapInfo & { fileUrl: string }>();

  /** What Nadeo (and TMX) know of a map uid. A uid names one exact file, so this never goes stale. */
  async mapInfo(mapUid: string): Promise<NadeoMapInfo & { fileUrl: string }> {
    const cached = this.mapInfos.get(mapUid);
    if (cached) return cached;
    type CoreMap = { mapId: string; mapUid: string; name: string; author: string; authorScore: number; goldScore: number; fileUrl: string };
    const maps = await this.get<CoreMap[]>("NadeoServices", `${CORE}/maps/?mapUidList=${encodeURIComponent(mapUid)}`);
    const m = maps[0];
    if (!m) throw new Error("Nadeo does not know this map");
    this.mapIds.set(mapUid, m.mapId);
    // The same uid on TMX is the same file, and a TMX identity brings the card and the replays.
    let tmxId: number | null = null;
    try {
      const res = await fetch(`https://trackmania.exchange/api/maps?uid=${encodeURIComponent(mapUid)}&fields=MapId`, { headers: { "User-Agent": USER_AGENT } });
      if (res.ok) tmxId = ((await res.json()) as { Results?: { MapId?: number }[] }).Results?.[0]?.MapId ?? null;
    } catch { /* TMX down: the map still loads from Nadeo */ }
    const info = { mapUid, name: stripFormat(m.name), authorAccountId: m.author, authorTime: m.authorScore, goldTime: m.goldScore, tmxId, fileUrl: m.fileUrl };
    // An unknown TMX id may only mean TMX was unreachable: ask again next time.
    if (tmxId !== null) this.mapInfos.set(mapUid, info);
    return info;
  }

  /** The map file as Nadeo serves it to the game. */
  async mapFile(mapUid: string): Promise<Buffer> {
    const { fileUrl } = await this.mapInfo(mapUid);
    let res = await fetch(fileUrl, { headers: { "User-Agent": USER_AGENT } });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(fileUrl, { headers: { Authorization: `nadeo_v1 t=${await this.token("NadeoServices")}`, "User-Agent": USER_AGENT } });
    }
    if (!res.ok) throw new Error(`map download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async mapId(mapUid: string): Promise<string> {
    const cached = this.mapIds.get(mapUid);
    if (cached) return cached;
    const maps = await this.get<{ mapId: string }[]>("NadeoServices",
      `${CORE}/maps/?mapUidList=${encodeURIComponent(mapUid)}`);
    const mapId = maps[0]?.mapId;
    if (!mapId) throw new Error("Nadeo does not know this map (is it uploaded to the game servers?)");
    this.mapIds.set(mapUid, mapId);
    return mapId;
  }

  /** The stored records (with ghost file URLs) of some accounts on a map. */
  private async mapRecords(mapUid: string, accountIds: string[]) {
    type Rec = { accountId: string; mapRecordId?: string; url?: string; recordScore?: { time?: number } };
    const mapId = await this.mapId(mapUid);
    const out: Rec[] = [];
    for (let i = 0; i < accountIds.length; i += 50) {
      const ids = accountIds.slice(i, i + 50).map(encodeURIComponent).join(",");
      out.push(...await this.get<Rec[]>("NadeoServices", `${CORE}/v2/mapRecords/?accountIdList=${ids}&mapId=${mapId}`));
    }
    return out;
  }

  /** Download a record's ghost file once; later calls reuse the cached copy. */
  private async recordFile(rec: { mapRecordId?: string; url?: string; accountId: string }): Promise<string> {
    if (!rec.url) throw new Error("record has no ghost file");
    await mkdir(CACHE_DIR, { recursive: true });
    const file = join(CACHE_DIR, `${rec.mapRecordId ?? rec.accountId}.Ghost.Gbx`);
    if (await stat(file).then((s) => s.size > 0, () => false)) return file;
    // Ghost storage objects are public; fall back to the token if not.
    let res = await fetch(rec.url, { headers: { "User-Agent": USER_AGENT } });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(rec.url, {
        headers: { Authorization: `nadeo_v1 t=${await this.token("NadeoServices")}`, "User-Agent": USER_AGENT },
      });
    }
    if (!res.ok) throw new Error(`ghost download ${res.status}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return file;
  }

  /**
   * Nicknames without an OAuth app: each record's ghost file names its
   * driver. The files are small, and the download is reused when the
   * line is loaded.
   */
  private async namesFromRecordFiles(mapUid: string, accountIds: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    try {
      const recs = (await this.mapRecords(mapUid, accountIds)).filter((r) => r.url);
      const files = new Map<string, string>();
      let next = 0;
      const worker = async () => {
        while (next < recs.length) {
          const rec = recs[next++];
          try {
            files.set(await this.recordFile(rec), rec.accountId);
          } catch (err) {
            console.warn("[nadeo] record file:", err instanceof Error ? err.message : err);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, recs.length) }, worker));
      if (files.size) {
        const json = await new Promise<string>((resolve, reject) =>
          execFile(this.meshdump, ["ghostname", ...files.keys()], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (err, stdout) => (err ? reject(err) : resolve(stdout))));
        for (const [file, name] of Object.entries(JSON.parse(json) as Record<string, string | null>)) {
          const id = files.get(file);
          if (id && name) {
            this.names.set(id, name);
            found.set(id, name);
          }
        }
      }
    } catch (err) {
      console.warn("[nadeo] names from record files unavailable:", err instanceof Error ? err.message : err);
    }
    return found;
  }

  /**
   * Players by (partial) name. Nadeo's own services only resolve an EXACT
   * display name, and only with an OAuth app; trackmania.io searches by
   * substring. Both are tried, plus every name this session has already seen.
   */
  private async findPlayers(text: string): Promise<{ players: Map<string, string>; via: string[] }> {
    const players = new Map<string, string>();
    const via: string[] = [];
    const needle = text.toLowerCase();
    for (const [id, name] of this.names) if (name.toLowerCase().includes(needle)) players.set(id, name);
    if (players.size) via.push("names seen this session");
    try {
      const res = await fetch(`${TMIO}/players/find?search=${encodeURIComponent(text)}`, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const found = (await res.json()) as { player?: { id?: string; name?: string } }[];
      for (const f of Array.isArray(found) ? found : []) if (f.player?.id && f.player.name) players.set(f.player.id, f.player.name);
      via.push("trackmania.io");
    } catch (err) {
      console.warn("[nadeo] trackmania.io player search unavailable:", err instanceof Error ? err.message : err);
    }
    const { clientId, clientSecret } = this.cfg.oauth ?? {};
    if (clientId && clientSecret) {
      try {
        if (!this.oauthToken || Date.now() - this.oauthToken.at > TOKEN_TTL_MS) this.oauthToken = await this.oauthLogin(clientId, clientSecret);
        const res = await fetch(`${OAUTH}/display-names/account-ids?displayName[]=${encodeURIComponent(text)}`, {
          headers: { Authorization: `Bearer ${this.oauthToken.token}`, "User-Agent": USER_AGENT },
        });
        if (res.ok) {
          for (const [name, id] of Object.entries((await res.json()) as Record<string, string>)) players.set(id, name);
          via.push("exact name (Nadeo)");
        }
      } catch (err) {
        console.warn("[nadeo] exact-name lookup unavailable:", err instanceof Error ? err.message : err);
      }
    }
    for (const [id, name] of players) this.names.set(id, name);
    return { players, via };
  }

  private async oauthLogin(clientId: string, clientSecret: string): Promise<{ token: string; at: number }> {
    const res = await fetch(`${OAUTH}/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error(`OAuth token ${res.status}`);
    return { token: json.access_token, at: Date.now() };
  }

  /**
   * World position of a record. The "surround" endpoint answers nothing to a
   * server account, so the leaderboard is read instead: the top 100 in one
   * request, beyond that a binary search by offset (about 13 small requests;
   * probes are shared within one search).
   */
  private async positionOf(mapUid: string, accountId: string, time: number, probes: Map<number, { accountId: string; score: number; zoneName?: string } | null>): Promise<{ position: number; zone: string }> {
    type Row = { accountId: string; position: number; score: number; zoneName?: string };
    type Top = { tops?: { top?: Row[] }[] };
    const at = async (offset: number) => {
      if (!probes.has(offset)) {
        const json = await this.get<Top>("NadeoLiveServices",
          `${LIVE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}/top?onlyWorld=true&length=1&offset=${offset}`);
        probes.set(offset, json.tops?.[0]?.top?.[0] ?? null);
      }
      return probes.get(offset)!;
    };
    try {
      // The top 100 in one request covers most searches.
      if (!probes.has(-1)) {
        const json = await this.get<Top>("NadeoLiveServices",
          `${LIVE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}/top?onlyWorld=true&length=100&offset=0`);
        (json.tops?.[0]?.top ?? []).forEach((row, i) => probes.set(i, row));
        probes.set(-1, null);
      }
      for (let o = 0; o < 100 && probes.get(o); o++) {
        const row = probes.get(o)!;
        if (row.accountId === accountId) return { position: o + 1, zone: row.zoneName ?? "" };
      }
      if (!probes.get(99)) return { position: 0, zone: "" }; // fewer than 100 records and not among them
      // First offset whose score is >= time; ties are walked through below.
      let lo = 100, hi = 10000;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const row = await at(mid);
        if (row && row.score < time) lo = mid + 1; else hi = mid;
      }
      for (let o = lo; o < lo + 5; o++) {
        const row = await at(o);
        if (!row || row.score !== time) break;
        if (row.accountId === accountId) return { position: o + 1, zone: row.zoneName ?? "" };
      }
      return { position: (await at(lo))?.score === time ? lo + 1 : 0, zone: "" };
    } catch {
      return { position: 0, zone: "" };
    }
  }

  /**
   * Records on a map by players whose name contains `text`, fastest first.
   * At most 50 name matches are checked for a record (one request).
   */
  async searchRecords(mapUid: string, text: string): Promise<{ records: NadeoRecord[]; via: string[]; matched: number }> {
    const { players, via } = await this.findPlayers(text);
    const ids = [...players.keys()].slice(0, 50);
    if (!ids.length) return { records: [], via, matched: 0 };
    const recs = (await this.mapRecords(mapUid, ids)).filter((r) => r.recordScore?.time);
    recs.sort((a, b) => (a.recordScore!.time! - b.recordScore!.time!));
    const records: NadeoRecord[] = [];
    const probes = new Map<number, { accountId: string; score: number; zoneName?: string } | null>();
    for (const r of recs.slice(0, 20)) {
      const place = records.length < 5 ? await this.positionOf(mapUid, r.accountId, r.recordScore!.time!, probes) : { position: 0, zone: "" };
      records.push({
        accountId: r.accountId,
        name: players.get(r.accountId) ?? r.accountId.slice(0, 8),
        position: place.position,
        time: r.recordScore!.time!,
        zone: place.zone,
      });
    }
    return { records, via, matched: players.size };
  }

  /** Remember a name learned from a downloaded ghost. */
  rememberName(accountId: string, name: string | null | undefined): void {
    if (name) this.names.set(accountId, name);
  }

  /** The ghost file of one account's record on a map (path in the cache). */
  async ghostFile(mapUid: string, accountId: string): Promise<{ file: string; time: number }> {
    const rec = (await this.mapRecords(mapUid, [accountId]))[0];
    if (!rec?.url) throw new Error("no record ghost for that account on this map");
    return { file: await this.recordFile(rec), time: rec.recordScore?.time ?? 0 };
  }
}

const readConfig = (root: string): NadeoConfig => {
  try {
    return (JSON.parse(readFileSync(join(root, ".trackedit.local.json"), "utf-8")) as { nadeo?: NadeoConfig }).nadeo ?? {};
  } catch {
    return {};
  }
};

export function nadeoBridge(meshdump: string, loadMapFile: MapLoader): Plugin {
  return {
    name: "nadeo-bridge",
    configureServer(server) {
      // Re-read the config per client so edits to the local file apply
      // without a restart; the client caches tokens for its config.
      let client: NadeoClient | null = null;
      let clientKey = "";
      const getClient = () => {
        const cfg = readConfig(process.cwd());
        const key = JSON.stringify(cfg);
        if (!client || key !== clientKey) {
          client = new NadeoClient(cfg, meshdump);
          clientKey = key;
        }
        return client;
      };
      const send = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };

      server.middlewares.use("/api/nadeo/status", (_req, res) => {
        send(res, 200, { configured: getClient().configured });
      });

      server.middlewares.use("/api/nadeo/records", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://x");
          const mapUid = url.pathname.split("/").filter(Boolean).pop();
          if (!mapUid) return send(res, 400, { error: "map uid required" });
          const c = getClient();
          if (!c.configured) return send(res, 404, { error: "Nadeo account not configured", configured: false });
          const length = Math.min(Math.max(Number(url.searchParams.get("length")) || 50, 1), 100);
          send(res, 200, { records: await c.records(mapUid, length) });
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/nadeo/search", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://x");
          const mapUid = url.pathname.split("/").filter(Boolean).pop();
          const name = (url.searchParams.get("name") ?? "").trim();
          if (!mapUid) return send(res, 400, { error: "map uid required" });
          if (name.length < 2) return send(res, 400, { error: "type at least two characters of the player's name" });
          const c = getClient();
          if (!c.configured) return send(res, 404, { error: "Nadeo account not configured", configured: false });
          send(res, 200, await c.searchRecords(mapUid, name));
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/nadeo/rooms", async (req, res) => {
        try {
          const name = (new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "").trim();
          if (name.length < 2) return send(res, 400, { error: "type at least two characters of the server's name" });
          const c = getClient();
          if (!c.configured) return send(res, 404, { error: "Nadeo account not configured", configured: false });
          send(res, 200, await c.searchRooms(name));
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/nadeo/room", async (req, res) => {
        try {
          const [clubId, activityId] = new URL(req.url ?? "", "http://x").pathname.split("/").filter(Boolean).map(Number);
          if (!Number.isInteger(clubId) || !Number.isInteger(activityId)) return send(res, 400, { error: "club id and activity id required" });
          const c = getClient();
          if (!c.configured) return send(res, 404, { error: "Nadeo account not configured", configured: false });
          send(res, 200, await c.room(clubId, activityId));
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/nadeo/map", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://x");
          const mapUid = url.pathname.split("/").filter(Boolean).pop();
          if (!mapUid || !/^[\w-]{20,40}$/.test(mapUid)) return send(res, 400, { error: "map uid required" });
          const c = getClient();
          if (!c.configured) return send(res, 404, { error: "Nadeo account not configured", configured: false });
          if (!url.searchParams.has("load")) {
            const { fileUrl: _file, ...info } = await c.mapInfo(mapUid);
            return send(res, 200, info);
          }
          const dump = await loadMapFile(await c.mapFile(mapUid), { keepAs: nadeoTemplatePath(mapUid), label: `nadeo-${mapUid}` });
          send(res, 200, dump);
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/nadeo/finishes", async (req, res) => {
        try {
          const mapUid = (req.url ?? "").split("?")[0].split("/").filter(Boolean).pop();
          if (!mapUid) return send(res, 400, { error: "map uid required" });
          const c = getClient();
          if (!c.configured) return send(res, 404, { error: "Nadeo account not configured", configured: false });
          send(res, 200, { finishes: await c.finishCount(mapUid) });
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/nadeo/ghost", async (req, res) => {
        let dir: string | null = null;
        try {
          const url = new URL(req.url ?? "", "http://x");
          const mapUid = url.pathname.split("/").filter(Boolean).pop();
          const accountId = url.searchParams.get("account");
          if (!mapUid || !accountId) return send(res, 400, { error: "map uid and account required" });
          const c = getClient();
          if (!c.configured) return send(res, 404, { error: "Nadeo account not configured", configured: false });
          const { file: ghostGbx, time } = await c.ghostFile(mapUid, accountId);
          dir = await mkdtemp(join(tmpdir(), "trackedit-nadeo-"));
          const out = join(dir, "ghost.json");
          await new Promise<void>((resolve, reject) => {
            // windowsHide: a dev server with no console of its own (started from an IDE task, detached)
            // makes Windows allocate a console per child, and that fails with 0xC0000142
            // (STATUS_DLL_INIT_FAILED) when the machine is short of resources. Every spawn has it.
            execFile(meshdump, ["ghost", ghostGbx, out], { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
              if (!err) return resolve();
              // Say WHY: a bare "Command failed" hides an exit code, a kill signal or what the tool printed.
              const e = err as Error & { code?: number | string; signal?: string | null };
              const said = (stderr || stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
              reject(new Error(`ghost extraction failed (exit ${e.code ?? "?"}${e.signal ? `, signal ${e.signal}` : ""}): ${said || e.message}`));
            });
          });
          const ghost = JSON.parse(await readFile(out, "utf-8")) as Record<string, unknown>;
          c.rememberName(accountId, ghost.nickname as string | null | undefined);
          send(res, 200, { source: "nadeo", accountId, raceTimeMs: time || ghost.raceTimeMs, ...ghost, ...(time ? { raceTimeMs: time } : {}) });
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      });
    },
  };
}
