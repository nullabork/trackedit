import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMapLoader } from "./tools/mapLoader";
import { liveBridge } from "./tools/liveBridge";
import { nadeoBridge } from "./tools/nadeoBridge";
import { gameBridge, tmxTemplatePath } from "./tools/gameBridge";

/** Machine-local settings (gitignored): Openplanet folder and optional
 *  external gbxdump override. TMX import otherwise uses meshdump's map command. */
const localCfg = (): { openplanetDir?: string; gbxdump?: string } => {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), ".trackedit.local.json"), "utf-8"));
  } catch {
    return {};
  }
};
const gbxdumpPath = (): string => process.env.TRACKEDIT_GBXDUMP ?? localCfg().gbxdump ?? "";
const MESHDUMP = process.env.TRACKEDIT_MESHDUMP ??
  join(process.cwd(), "tools", "meshdump", "bin", "Release", "net8.0",
    process.platform === "win32" ? "meshdump.exe" : "meshdump");

/** Downloaded map file -> editor dump; shared by the TMX and the Nadeo (club room) bridges. */
const loadMapFile = createMapLoader({ root: process.cwd(), meshdump: MESHDUMP, gbxdump: gbxdumpPath });

/**
 * Dev-server bridge to TrackmaniaExchange: the browser can't call TMX (CORS)
 * or run the .NET converter, but the dev server can do both.
 *
 *   GET /api/tmx/search?q=…      -> TMX map search JSON; q is a name, a TMX map
 *                                   id ("84442", "#84442") or a TMX map URL
 *   GET /api/tmx/load/:id        -> downloads the map, runs gbxdump, returns dump JSON
 *                                   (+ `ghost` when the map carries a validation ghost)
 *   GET /api/tmx/info/:id        -> the map's TMX card: name, uid, uploader/authors, medals,
 *                                   awards, replays, downloads, tags, upload date, ghost blocks
 *   GET /api/tmx/replays/:id     -> the map's TMX replays (id, time, driver, date) + author time
 *   GET /api/tmx/ghost/:id       -> the driving path of the TMX replay closest to the
 *                                   map's author time (404 when the map has no replay file);
 *                                   ?replay=<ReplayId> picks one, ?source=map extracts the
 *                                   map's own validation ghost instead
 */
function tmxBridge(): Plugin {
  const TMX_HEADERS = { "User-Agent": "trackedit-dev" };
  /** `meshdump ghost`: the path JSON, or null when the file holds no ghost. */
  const extractGhost = (gbx: string, out: string) =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      execFile(MESHDUMP, ["ghost", gbx, out], { timeout: 120_000, windowsHide: true }, async (err) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(await readFile(out, "utf-8"))); } catch { resolve(null); }
      });
    });
  return {
    name: "tmx-bridge",
    configureServer(server) {
      type TmxReplay = { ReplayId: number; ReplayTime: number; HasFile?: boolean; User?: { Name?: string }; ReplayAt?: string; Position?: number };
      const tmxReplays = async (id: string) => {
        const mapRes = await fetch(
          `https://trackmania.exchange/api/maps?id=${id}&fields=${encodeURIComponent("MapId,MapUid,Medals.Author,Medals.Gold")}`,
          { headers: TMX_HEADERS });
        const mapJson = (await mapRes.json()) as { Results?: { MapUid?: string; Medals?: { Author?: number; Gold?: number } }[] };
        const authorTime = mapJson.Results?.[0]?.Medals?.Author ?? 0;
        const mapUid = mapJson.Results?.[0]?.MapUid ?? null;
        const listRes = await fetch(
          `https://trackmania.exchange/api/replays?mapid=${id}&count=100&fields=${encodeURIComponent("ReplayId,ReplayTime,HasFile,User.Name,ReplayAt,Position")}`,
          { headers: TMX_HEADERS });
        if (!listRes.ok) throw new Error(`TMX replays ${listRes.status}`);
        const list = (await listRes.json()) as { Results?: TmxReplay[] };
        const replays = (list.Results ?? []).filter((r) => r.HasFile !== false && r.ReplayTime > 0);
        return { authorTime, mapUid, replays };
      };

      server.middlewares.use("/api/tmx/info", async (req, res) => {
        try {
          const id = (req.url ?? "").split("?")[0].split("/").filter(Boolean).pop();
          if (!id || !/^\d+$/.test(id)) throw new Error("bad map id");
          const fields = "MapId,Name,MapUid,OnlineMapId,Uploader.Name,Uploader.UserId,Authors,Medals.Author,Medals.Gold,Medals.Silver,Medals.Bronze,"
            + "AwardCount,ReplayCount,DownloadCount,CommentCount,UploadedAt,UpdatedAt,HasGhostBlocks,Tags,EmbeddedObjectsCount,MapType";
          const r = await fetch(`https://trackmania.exchange/api/maps?id=${id}&fields=${encodeURIComponent(fields)}`, { headers: TMX_HEADERS });
          if (!r.ok) throw new Error(`TMX ${r.status}`);
          type Info = {
            MapId: number; Name: string; MapUid?: string; OnlineMapId?: string;
            Uploader?: { Name?: string; UserId?: number };
            Authors?: { User?: { Name?: string; UserId?: number }; Role?: string }[];
            Medals?: { Author?: number; Gold?: number; Silver?: number; Bronze?: number };
            AwardCount?: number; ReplayCount?: number; DownloadCount?: number; CommentCount?: number;
            UploadedAt?: string; UpdatedAt?: string; HasGhostBlocks?: boolean; Tags?: { Name?: string }[];
            EmbeddedObjectsCount?: number; MapType?: string;
          };
          const m = ((await r.json()) as { Results?: Info[] }).Results?.[0];
          if (!m) { res.statusCode = 404; res.end(JSON.stringify({ error: "not on TMX" })); return; }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            mapId: m.MapId, name: m.Name, mapUid: m.MapUid ?? null, onlineMapId: m.OnlineMapId ?? null,
            uploader: { name: m.Uploader?.Name ?? "", userId: m.Uploader?.UserId ?? null },
            authors: (m.Authors ?? []).map((a) => ({ name: a.User?.Name ?? "", userId: a.User?.UserId ?? null, role: a.Role ?? "" })),
            medals: { author: m.Medals?.Author ?? 0, gold: m.Medals?.Gold ?? 0, silver: m.Medals?.Silver ?? 0, bronze: m.Medals?.Bronze ?? 0 },
            awardCount: m.AwardCount ?? 0, replayCount: m.ReplayCount ?? 0, downloadCount: m.DownloadCount ?? 0, commentCount: m.CommentCount ?? 0,
            uploadedAt: m.UploadedAt ?? null, updatedAt: m.UpdatedAt ?? null, hasGhostBlocks: !!m.HasGhostBlocks,
            tags: (m.Tags ?? []).map((t) => t.Name ?? "").filter(Boolean), embeddedObjects: m.EmbeddedObjectsCount ?? 0, mapType: m.MapType ?? "",
          }));
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      server.middlewares.use("/api/tmx/replays", async (req, res) => {
        try {
          const id = (req.url ?? "").split("?")[0].split("/").filter(Boolean).pop();
          if (!id || !/^\d+$/.test(id)) throw new Error("bad map id");
          const { authorTime, mapUid, replays } = await tmxReplays(id);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            authorTime,
            mapUid,
            replays: replays.map((r) => ({
              replayId: r.ReplayId, time: r.ReplayTime, driver: r.User?.Name ?? "", at: r.ReplayAt ?? "", position: r.Position ?? null,
            })),
          }));
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      server.middlewares.use("/api/tmx/ghost", async (req, res) => {
        let dir: string | null = null;
        const fail = (code: number, msg: string) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: msg }));
        };
        try {
          const url = new URL(req.url ?? "", "http://x");
          const id = url.pathname.split("/").filter(Boolean).pop();
          if (!id || !/^\d+$/.test(id)) return fail(400, "bad map id");
          if (url.searchParams.get("source") === "map") {
            // The map's own validation ghost: re-download the map and extract.
            const mapFile = await fetch(`https://trackmania.exchange/maps/download/${id}`, { headers: TMX_HEADERS });
            if (!mapFile.ok) return fail(502, `TMX map download ${mapFile.status}`);
            dir = await mkdtemp(join(tmpdir(), "trackedit-ghost-"));
            const mapGbx = join(dir, "map.Map.Gbx");
            await writeFile(mapGbx, Buffer.from(await mapFile.arrayBuffer()));
            const mapGhost = await extractGhost(mapGbx, join(dir, "ghost.json"));
            if (!mapGhost) return fail(404, "the map has no validation ghost");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ source: "map", ...mapGhost }));
            return;
          }
          const { authorTime, replays } = await tmxReplays(id);
          const usable = [...replays];
          if (!usable.length) return fail(404, "no replay with a file on TMX");
          const wanted = Number(url.searchParams.get("replay"));
          // A specific replay, else the one closest to the author time: a
          // representative clean line, not a cut or a crawl. Without an
          // author time, the fastest.
          usable.sort((a, b) => authorTime
            ? Math.abs(a.ReplayTime - authorTime) - Math.abs(b.ReplayTime - authorTime)
            : a.ReplayTime - b.ReplayTime);
          const pick = wanted ? usable.find((r) => r.ReplayId === wanted) : usable[0];
          if (!pick) return fail(404, `replay #${wanted} is not on this map`);
          const file = await fetch(`https://trackmania.exchange/recordgbx/${pick.ReplayId}`, { headers: TMX_HEADERS });
          if (!file.ok) return fail(502, `TMX replay download ${file.status}`);
          dir = await mkdtemp(join(tmpdir(), "trackedit-ghost-"));
          const gbx = join(dir, "replay.Replay.Gbx");
          await writeFile(gbx, Buffer.from(await file.arrayBuffer()));
          const ghost = await extractGhost(gbx, join(dir, "ghost.json"));
          if (!ghost) return fail(404, `replay #${pick.ReplayId} holds no readable ghost`);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            source: "tmx", replayId: pick.ReplayId, replayTime: pick.ReplayTime, authorTime,
            nickname: pick.User?.Name ?? ghost.nickname ?? null, ...ghost,
          }));
        } catch (err) {
          fail(500, String(err));
        } finally {
          if (dir) void rm(dir, { recursive: true, force: true });
        }
      });

      server.middlewares.use("/api/tmx/search", async (req, res) => {
        try {
          const q = (new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "").trim();
          // A bare id ("84442", "#84442") or a TMX map link
          // (trackmania.exchange/maps/84442, /mapshow/84442, ?id=84442) looks
          // the map up by id; anything else is a name search.
          const idMatch = /^#?(\d+)$/.exec(q) ?? /(?:\/maps\/|\/mapshow\/|[?&]id=)(\d+)/i.exec(q);
          const query = idMatch ? `id=${idMatch[1]}` : `name=${encodeURIComponent(q)}&count=25`;
          const api = `https://trackmania.exchange/api/maps?${query}&fields=${encodeURIComponent("MapId,Name,Uploader.Name,AwardCount,Medals.Author")}`;
          const upstream = await fetch(api, { headers: { "User-Agent": "trackedit-dev" } });
          res.setHeader("content-type", "application/json");
          res.end(await upstream.text());
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      server.middlewares.use("/api/tmx/load", async (req, res) => {
        try {
          const id = (req.url ?? "").split("/").filter(Boolean).pop();
          if (!id || !/^\d+$/.test(id)) throw new Error("bad map id");
          const upstream = await fetch(`https://trackmania.exchange/maps/download/${id}`, {
            headers: { "User-Agent": "trackedit-dev" },
          });
          if (!upstream.ok) throw new Error(`TMX download ${upstream.status}`);
          const dump = await loadMapFile(Buffer.from(await upstream.arrayBuffer()), { keepAs: tmxTemplatePath(id), label: `tmx-${id}` });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(dump));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

/**
 * Server-side map store: JSON files under maps/ so saved tracks open from
 * ANY browser/profile on this machine (localStorage/IndexedDB are
 * per-profile; a future multi-user DB can sit behind these same endpoints).
 *
 *   GET    /api/maps          -> [{id,name,updatedAt,placementCount,...}]
 *   GET    /api/maps/:id      -> full stored map
 *   PUT    /api/maps/:id      -> save (body = full stored map)
 *   DELETE /api/maps/:id
 */
function mapStoreBridge(): Plugin {
  const dir = join(process.cwd(), "maps");
  const fileFor = (id: string) => join(dir, `${id}.json`);
  const okId = (id: string | undefined): id is string => !!id && /^[\w.-]+$/.test(id);
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  return {
    name: "map-store",
    configureServer(server) {
      server.middlewares.use("/api/maps", async (req, res) => {
        try {
          await mkdir(dir, { recursive: true });
          const id = (req.url ?? "").split("?")[0].split("/").filter(Boolean).pop();

          if (req.method === "GET" && (!id || id === "maps" || (req.url ?? "") === "/")) {
            const metas = [];
            for (const f of await readdir(dir)) {
              if (!f.endsWith(".json")) continue;
              try {
                const rec = JSON.parse(await readFile(join(dir, f), "utf-8"));
                const { layers: _l, ...meta } = rec;
                metas.push(meta);
              } catch { /* unreadable file, skip */ }
            }
            send(res, 200, metas);
            return;
          }
          if (!okId(id)) {
            send(res, 400, { error: "bad id" });
            return;
          }
          if (req.method === "GET") {
            send(res, 200, await readFile(fileFor(id), "utf-8"));
          } else if (req.method === "PUT") {
            await writeFile(fileFor(id), await readBody(req));
            send(res, 200, { ok: true });
          } else if (req.method === "DELETE") {
            await unlink(fileFor(id)).catch(() => {});
            send(res, 200, { ok: true });
          } else {
            send(res, 405, { error: "method" });
          }
        } catch (err) {
          send(res, (err as { code?: string }).code === "ENOENT" ? 404 : 500, {
            error: String(err),
          });
        }
      });
    },
  };
}

/**
 * Mod (custom texture pack) library. Maps can embed a mod URL; the game
 * downloads and applies it — we mirror that. Downloaded mods are shared:
 * once fetched, ANY map can apply them. Everything lives (gitignored)
 * under public/meshes/mods/<slug>/.
 *
 *   GET  /api/mods            -> [{slug, name, url, materials}]
 *   POST /api/mods {url}      -> download + convert (idempotent) -> {slug, materials}
 *   GET  /api/mods/:slug      -> that mod's mod.json
 */
function modsBridge(): Plugin {
  const modsDir = join(process.cwd(), "public", "meshes", "mods");
  const registryPath = join(modsDir, "index.json");
  type ModEntry = { slug: string; name: string; url: string; materials: number };

  const readRegistry = async (): Promise<ModEntry[]> => {
    try {
      return JSON.parse(await readFile(registryPath, "utf-8")) as ModEntry[];
    } catch {
      return [];
    }
  };
  const slugFor = (url: string): string => {
    const base = (url.split("/").pop() ?? "mod").replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "_");
    let h = 0;
    for (const c of url) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `${base}-${h.toString(36)}`;
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  return {
    name: "mods-bridge",
    configureServer(server) {
      server.middlewares.use("/api/mods", async (req, res) => {
        res.setHeader("content-type", "application/json");
        try {
          await mkdir(modsDir, { recursive: true });
          const slug = (req.url ?? "").split("?")[0].split("/").filter(Boolean).pop();

          if (req.method === "GET" && slug && slug !== "mods") {
            res.end(await readFile(join(modsDir, slug, "mod.json"), "utf-8"));
            return;
          }
          if (req.method === "GET") {
            res.end(JSON.stringify(await readRegistry()));
            return;
          }
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end('{"error":"method"}');
            return;
          }

          const { url, name } = JSON.parse(await readBody(req)) as { url?: string; name?: string };
          if (!url || !/^https?:\/\//i.test(url)) throw new Error("bad mod url");
          const id = slugFor(url);
          const registry = await readRegistry();
          const existing = registry.find((m) => m.slug === id);
          if (existing) {
            res.end(JSON.stringify(existing));
            return;
          }

          const upstream = await fetch(url, { headers: { "User-Agent": "trackedit-dev" } });
          if (!upstream.ok) throw new Error(`mod download ${upstream.status}`);
          const zipPath = join(modsDir, `${id}.zip`);
          await writeFile(zipPath, Buffer.from(await upstream.arrayBuffer()));
          const outDir = join(modsDir, id);
          await new Promise<void>((resolve, reject) => {
            execFile(MESHDUMP, ["modpack", zipPath, outDir], { timeout: 300_000, windowsHide: true },
              (err, _stdout, stderr) =>
                err ? reject(new Error(`modpack: ${stderr?.toString().trim() || err.message}`)) : resolve());
          });
          await unlink(zipPath).catch(() => {});
          const mod = JSON.parse(await readFile(join(outDir, "mod.json"), "utf-8")) as {
            materials: Record<string, string>;
          };
          const entry: ModEntry = {
            slug: id,
            name: name || id.replace(/-\w+$/, ""),
            url,
            materials: Object.keys(mod.materials).length,
          };
          registry.push(entry);
          await writeFile(registryPath, JSON.stringify(registry, null, 1));
          res.end(JSON.stringify(entry));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

/**
 * First-run setup: game assets (meshes/textures) are Nadeo's content and
 * never ship with the repo — each user extracts them from their OWN game
 * install via Openplanet, then imports them here. This bridge drives the
 * in-app setup dialog (ui/SetupDialog.ts):
 *
 *   GET  /api/setup/status  -> where we are (dir, plugin, extraction, meshes)
 *   POST /api/setup/dir     -> {dir} remember the OpenplanetNext folder
 *                              (persisted in .trackedit.local.json, gitignored)
 *                              + install/refresh the extractor plugin into it
 *   POST /api/setup/gamedir -> {dir} remember the game's install folder (optional: the
 *                              light colours ship as Packs/Stadium_Skins.zip next to
 *                              Trackmania.exe, not in the Openplanet extraction)
 *   POST /api/setup/import  -> run meshdump blocks+items -> public/meshes/
 *                              (async; progress rides in status.importing)
 *   POST /api/setup/reset   -> delete public/meshes/ (all imported assets,
 *                              downloaded mods included) for a clean redo
 */
function setupBridge(): Plugin {
  const cfgPath = join(process.cwd(), ".trackedit.local.json");
  const pluginSrc = join(process.cwd(), "tools", "TrackeditExtract");
  const meshesDir = join(process.cwd(), "public", "meshes");

  type ImportState = {
    running: boolean;
    phase: string;
    /** 0..1 within the current phase (meshdump prints "progress a/b" lines). */
    progress: number | null;
    log: string[];
    error: string | null;
    done: boolean;
  };
  let importState: ImportState | null = null;

  const isDir = async (p: string) => {
    try { return (await stat(p)).isDirectory(); } catch { return false; }
  };
  const isFile = async (p: string) => {
    try { return (await stat(p)).isFile(); } catch { return false; }
  };
  const readCfg = async (): Promise<{ openplanetDir?: string; gameDir?: string }> => {
    try { return JSON.parse(await readFile(cfgPath, "utf-8")); } catch { return {}; }
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  // 17k files — count at most every 5s, the dialog polls faster than that.
  let extractCache: { at: number; n: number } | null = null;
  const countExtracted = async (opDir: string): Promise<number> => {
    if (extractCache && Date.now() - extractCache.at < 5000) return extractCache.n;
    let n = 0;
    try {
      const entries = await readdir(join(opDir, "Extract", "GameData"), {
        recursive: true,
        withFileTypes: true,
      });
      n = entries.filter((e) => e.isFile()).length;
    } catch { /* nothing extracted yet */ }
    extractCache = { at: Date.now(), n };
    return n;
  };

  /** The game's install has what we read from it directly. */
  const isGameDir = (dir: string) => isFile(join(dir, "Packs", "Stadium_Skins.zip"));
  /** The usual Steam / Epic / Ubisoft Connect places (tools/meshdump/GameInstall.cs looks in the same). */
  const detectGameDir = async (): Promise<string | null> => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    const guesses = process.platform === "win32"
      ? "CDEFGH".split("").flatMap((d) => [
          `${d}:\\SteamLibrary\\steamapps\\common\\Trackmania`,
          `${d}:\\Program Files (x86)\\Steam\\steamapps\\common\\Trackmania`,
          `${d}:\\Program Files\\Epic Games\\TrackmaniaNext`,
          `${d}:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania`,
          `${d}:\\Games\\Trackmania`,
        ])
      : [join(home, ".steam", "steam", "steamapps", "common", "Trackmania"),
         join(home, ".local", "share", "Steam", "steamapps", "common", "Trackmania")];
    for (const g of guesses) if (await isGameDir(g)) return g;
    return null;
  };

  /**
   * Data files a current import writes that an older one lacks — the editor runs without
   * them, but draws less correctly (clips, skins, wall trims, alternative models).
   */
  const outdatedParts = async (gameDirKnown: boolean): Promise<string[]> => {
    const missing: string[] = [];
    if (!(await isFile(join(meshesDir, "index.json")))) return missing;
    if (!(await isFile(join(meshesDir, "clipdefs.json")))) missing.push("clip rules");
    if (!(await isFile(join(meshesDir, "skins.json")))) missing.push("surface skins");
    if (!(await isFile(join(meshesDir, "waypoints.json")))) missing.push("waypoint types");
    if (!(await isFile(join(meshesDir, "car", "index.json")))) missing.push("the car model (run Trackedit Extract in the game again first)");
    if (gameDirKnown && !(await isFile(join(meshesDir, "lightcolors.json")))) missing.push("light colours");
    try {
      const idx = await readFile(join(meshesDir, "index.json"), "utf-8");
      if (!idx.includes('"mobils"')) missing.push("alternative block models");
    } catch { /* counted as not imported elsewhere */ }
    return missing;
  };

  /** A built converter older than its source (after a pull) must not be used as is. */
  const meshdumpIsCurrent = async (): Promise<boolean> => {
    try {
      const built = (await stat(MESHDUMP)).mtimeMs;
      const src = join(process.cwd(), "tools", "meshdump");
      for (const f of await readdir(src))
        if (/\.(cs|csproj)$/.test(f) && (await stat(join(src, f))).mtimeMs > built) return false;
      return true;
    } catch {
      return false;
    }
  };

  const installPlugin = (opDir: string) =>
    cp(pluginSrc, join(opDir, "Plugins", "TrackeditExtract"), { recursive: true, force: true });

  const startImport = async (opDir: string): Promise<void> => {
    if (importState?.running) return;
    const st: ImportState = {
      running: true, phase: "starting", progress: null, log: [], error: null, done: false,
    };
    importState = st;
    const push = (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const prog = /^progress (\d+)\/(\d+)$/.exec(t);
        if (prog) {
          st.progress = Number(prog[1]) / Math.max(1, Number(prog[2]));
          continue; // bar, not log noise
        }
        st.log.push(t);
        if (st.log.length > 25) st.log.shift();
      }
    };
    const extractRoot = join(opDir, "Extract", "GameData", "Stadium");
    // No exe, or one older than the source: `dotnet run` (re)builds it first.
    const haveExe = await meshdumpIsCurrent();
    const gameDir = (await readCfg()).gameDir;
    const env = gameDir ? { ...process.env, TRACKEDIT_GAME_DIR: gameDir } : process.env;
    const runOne = (cmd: string) =>
      new Promise<void>((resolve, reject) => {
        const args = [cmd, extractRoot, meshesDir];
        // First run has no built exe — `dotnet run` builds it (needs .NET 8 SDK).
        const child = haveExe
          ? spawn(MESHDUMP, args, { env, windowsHide: true })
          : spawn("dotnet", ["run", "-c", "Release", "--project", join("tools", "meshdump"), "--", ...args], { env, windowsHide: true });
        child.stdout.on("data", (d) => push(String(d)));
        child.stderr.on("data", (d) => push(String(d)));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`meshdump ${cmd} exited with code ${code}`)));
      });
    try {
      st.phase = "blocks";
      await runOne("blocks");
      st.phase = "items";
      st.progress = null;
      await runOne("items");
      // Which blocks/items are start, checkpoint, finish (meshes/waypoints.json).
      await runOne("waypoints");
      // The car, for playing driving lines back (meshes/car/; nothing when it was not extracted).
      await runOne("car");
      st.phase = "done";
      st.progress = 1;
      st.done = true;
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT/.test(msg) && !haveExe)
        msg = "dotnet not found — install the .NET 8 SDK (https://dotnet.microsoft.com) and retry";
      st.error = msg;
    } finally {
      st.running = false;
    }
  };

  return {
    name: "setup-bridge",
    configureServer(server) {
      server.middlewares.use("/api/setup", async (req, res) => {
        res.setHeader("content-type", "application/json");
        try {
          const sub = (req.url ?? "").split("?")[0].split("/").filter(Boolean).pop();

          if (req.method === "GET" && sub === "status") {
            const cfg = await readCfg();
            let openplanetDir = cfg.openplanetDir ?? null;
            let dirSource: "config" | "detected" | null = openplanetDir ? "config" : null;
            if (!openplanetDir) {
              const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
              const guesses = [
                join(home, "OpenplanetNext"),
                // Linux: TM2020 under Steam Proton (appid 2225070) puts it in the prefix.
                join(home, ".steam", "steam", "steamapps", "compatdata", "2225070",
                  "pfx", "drive_c", "users", "steamuser", "OpenplanetNext"),
                join(home, ".local", "share", "Steam", "steamapps", "compatdata", "2225070",
                  "pfx", "drive_c", "users", "steamuser", "OpenplanetNext"),
              ];
              for (const guess of guesses) {
                if (await isDir(guess)) {
                  openplanetDir = guess;
                  dirSource = "detected";
                  break;
                }
              }
            }
            const dirValid = !!openplanetDir && (await isDir(openplanetDir));
            const pluginInstalled =
              dirValid && (await isFile(join(openplanetDir!, "Plugins", "TrackeditExtract", "Main.as")));
            const extractedFiles = dirValid ? await countExtracted(openplanetDir!) : 0;
            let meshCount = 0;
            try {
              // index.json: { blocks: {name: entry}, items: {name: entry} }
              const idx = JSON.parse(await readFile(join(meshesDir, "index.json"), "utf-8")) as {
                blocks?: Record<string, unknown>;
                items?: Record<string, unknown>;
              };
              meshCount = Object.keys(idx.blocks ?? {}).length + Object.keys(idx.items ?? {}).length;
            } catch { /* not imported yet */ }
            let gameDir = cfg.gameDir ?? null;
            let gameDirSource: "config" | "detected" | null = gameDir ? "config" : null;
            if (!gameDir && (gameDir = await detectGameDir())) gameDirSource = "detected";
            const gameDirValid = !!gameDir && (await isGameDir(gameDir));
            res.end(JSON.stringify({
              gameDir,
              gameDirSource,
              gameDirValid,
              meshesOutdated: await outdatedParts(gameDirValid),
              openplanetDir,
              dirSource,
              dirValid,
              configured: !!cfg.openplanetDir,
              pluginInstalled,
              extractedFiles,
              extractReady: extractedFiles >= 5000,
              meshCount,
              meshesReady: meshCount >= 100,
              importing: importState,
            }));
            return;
          }

          if (req.method === "POST" && sub === "dir") {
            const { dir } = JSON.parse(await readBody(req)) as { dir?: string };
            if (!dir || !(await isDir(dir)))
              throw new Error(`not a folder: ${dir ?? "(empty)"}`);
            // Merge — the file also carries other machine-local keys (gbxdump).
            await writeFile(cfgPath, JSON.stringify({ ...(await readCfg()), openplanetDir: dir }, null, 1));
            extractCache = null;
            let pluginInstalled = true;
            try {
              await installPlugin(dir);
            } catch (err) {
              pluginInstalled = false;
              console.warn("[setup] plugin install failed:", err);
            }
            res.end(JSON.stringify({ ok: true, pluginInstalled }));
            return;
          }

          if (req.method === "POST" && sub === "gamedir") {
            const { dir } = JSON.parse(await readBody(req)) as { dir?: string };
            if (!dir || !(await isGameDir(dir)))
              throw new Error(`not the game's folder (no Packs/Stadium_Skins.zip in it): ${dir ?? "(empty)"}`);
            await writeFile(cfgPath, JSON.stringify({ ...(await readCfg()), gameDir: dir }, null, 1));
            res.end('{"ok":true}');
            return;
          }

          if (req.method === "POST" && sub === "reset") {
            if (importState?.running) throw new Error("import in progress — wait for it to finish");
            await rm(meshesDir, { recursive: true, force: true });
            await mkdir(meshesDir, { recursive: true });
            importState = null;
            res.end('{"ok":true}');
            return;
          }

          if (req.method === "POST" && sub === "import") {
            const cfg = await readCfg();
            if (!cfg.openplanetDir) throw new Error("set the Openplanet folder first");
            if ((await countExtracted(cfg.openplanetDir)) < 5000)
              throw new Error("no extracted game files yet — run Trackedit Extract in-game first");
            void startImport(cfg.openplanetDir);
            res.statusCode = 202;
            res.end('{"ok":true}');
            return;
          }

          res.statusCode = 404;
          res.end('{"error":"unknown setup endpoint"}');
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  };
}

/**
 * Live editor-state mirror for external tooling (or an AI assistant): the
 * app POSTs a snapshot on every state change (selection, layer, mode, map);
 * GET returns the latest one plus its age.
 *
 *   POST /api/debug/state -> store snapshot
 *   GET  /api/debug/state -> { ageSeconds, ...snapshot } (404 until first post)
 */
function debugBridge(): Plugin {
  let latest: { at: number; body: string } | null = null;
  return {
    name: "debug-state",
    configureServer(server) {
      // Screenshot round-trip: HTTP request -> ws "capture" to the app ->
      // the app renders + replies with a data URL -> PNG response.
      //   GET /api/debug/screenshot            -> frames the selection (falls back to view)
      //   GET /api/debug/screenshot?target=view -> current viewport as-is
      //   GET /api/debug/screenshot?uid=p-xxx   -> frames that placement
      const pendingShots = new Map<string, (dataUrl: string) => void>();
      server.ws.on(
        "trackedit:capture-result",
        (data: { id: string; dataUrl: string }) => {
          pendingShots.get(data.id)?.(data.dataUrl);
          pendingShots.delete(data.id);
        },
      );
      server.middlewares.use("/api/debug/screenshot", async (req, res) => {
        const q = new URL(req.url ?? "", "http://x").searchParams;
        const id = Math.random().toString(36).slice(2);
        const shot = new Promise<string>((resolve, reject) => {
          pendingShots.set(id, resolve);
          setTimeout(() => {
            pendingShots.delete(id);
            reject(new Error("timeout — is the editor tab open?"));
          }, 8000);
        });
        server.ws.send("trackedit:capture", {
          id,
          target: q.get("target") ?? "selection",
          uid: q.get("uid") ?? undefined,
          client: q.get("client") ?? undefined,
          yaw: q.has("yaw") ? Number(q.get("yaw")) : undefined,
          pitch: q.has("pitch") ? Number(q.get("pitch")) : undefined,
          distance: q.has("distance") ? Number(q.get("distance")) : undefined,
          isolate: q.get("isolate") === "1",
        });
        try {
          const dataUrl = await shot;
          const b64 = dataUrl.split(",")[1];
          if (!b64) throw new Error("capture failed in the app");
          res.setHeader("content-type", "image/png");
          res.end(Buffer.from(b64, "base64"));
        } catch (err) {
          res.statusCode = 503;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Command round-trip (same ws pattern): e.g.
      //   GET /api/debug/command?action=select&uid=p_xxx  -> selects that placement
      //   GET /api/debug/command?action=select            -> clears the selection
      const pendingCmds = new Map<string, (result: string) => void>();
      server.ws.on("trackedit:command-result", (data: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = data;
        pendingCmds.get(id)?.(JSON.stringify(rest));
        pendingCmds.delete(id);
      });
      server.middlewares.use("/api/debug/command", async (req, res) => {
        const q = new URL(req.url ?? "", "http://x").searchParams;
        const id = Math.random().toString(36).slice(2);
        const reply = new Promise<string>((resolve, reject) => {
          pendingCmds.set(id, resolve);
          setTimeout(() => {
            pendingCmds.delete(id);
            reject(new Error("timeout — is the editor tab open?"));
          }, 8000);
        });
        server.ws.send("trackedit:command", {
          id,
          action: q.get("action") ?? "",
          uid: q.get("uid") ?? undefined,
          client: q.get("client") ?? undefined,
          yaw: q.has("yaw") ? Number(q.get("yaw")) : undefined,
          pitch: q.has("pitch") ? Number(q.get("pitch")) : undefined,
          distance: q.has("distance") ? Number(q.get("distance")) : undefined,
          isolate: q.get("isolate") === "1",
        });
        res.setHeader("content-type", "application/json");
        try {
          res.end(await reply);
        } catch (err) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      server.middlewares.use("/api/debug/state", (req, res) => {
        if (req.method === "POST") {
          let data = "";
          req.on("data", (c) => (data += c));
          req.on("end", () => {
            latest = { at: Date.now(), body: data };
            res.end('{"ok":true}');
          });
          return;
        }
        res.setHeader("content-type", "application/json");
        if (!latest) {
          res.statusCode = 404;
          res.end('{"error":"no state posted yet (is the editor open?)"}');
          return;
        }
        const age = Math.round((Date.now() - latest.at) / 1000);
        res.end(`{"ageSeconds":${age},"state":${latest.body}}`);
      });
    },
  };
}

export default defineConfig({
  plugins: [tmxBridge(), nadeoBridge(MESHDUMP, loadMapFile), gameBridge(MESHDUMP), mapStoreBridge(), debugBridge(), modsBridge(), setupBridge(), liveBridge()],
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@input": fileURLToPath(new URL("./src/input", import.meta.url)),
      "@io": fileURLToPath(new URL("./src/io", import.meta.url)),
      "@render": fileURLToPath(new URL("./src/render", import.meta.url)),
      "@tools": fileURLToPath(new URL("./src/tools", import.meta.url)),
      "@plugins": fileURLToPath(new URL("./src/plugins", import.meta.url)),
      "@ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
    },
  },
  server: { port: 5199 },
});
