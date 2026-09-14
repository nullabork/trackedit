import type { Plugin } from "vite";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Dev-server bridge to Nadeo's record services — the leaderboard the game
 * shows in single player, and the ghost file behind each record.
 *
 *   GET /api/nadeo/status                       -> { configured }
 *   GET /api/nadeo/records/:mapUid?length=50    -> { records: [{ accountId, name, position, time, zone }] }
 *   GET /api/nadeo/ghost/:mapUid?account=<id>   -> the record's driving path (meshdump ghost JSON)
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

const CORE = "https://prod.trackmania.core.nadeo.online";
const LIVE = "https://live-services.trackmania.nadeo.live";
const OAUTH = "https://api.trackmania.com/api";
const USER_AGENT = "trackedit-dev / https://github.com/nullabork/trackedit";
/** Nadeo tokens last an hour; refresh a little early. */
const TOKEN_TTL_MS = 50 * 60_000;
/** Downloaded record files (small: tens of KB) — reused for names and lines. */
const CACHE_DIR = join(tmpdir(), "trackedit-nadeo-records");

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
          execFile(this.meshdump, ["ghostname", ...files.keys()], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
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

export function nadeoBridge(meshdump: string): Plugin {
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
            execFile(meshdump, ["ghost", ghostGbx, out], { timeout: 120_000 }, (err, _stdout, stderr) =>
              err ? reject(new Error(`ghost extraction failed: ${stderr || err.message}`)) : resolve());
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
