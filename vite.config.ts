import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMapConverter } from "./tools/mapConverter";
import { liveBridge } from "./tools/liveBridge";

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

/**
 * Dev-server bridge to TrackmaniaExchange: the browser can't call TMX (CORS)
 * or run the .NET converter, but the dev server can do both.
 *
 *   GET /api/tmx/search?q=name   -> TMX map search JSON
 *   GET /api/tmx/load/:id        -> downloads the map, runs gbxdump, returns dump JSON
 */
function tmxBridge(): Plugin {
  const convertMap = createMapConverter(process.cwd());
  return {
    name: "tmx-bridge",
    configureServer(server) {
      server.middlewares.use("/api/tmx/search", async (req, res) => {
        try {
          const q = new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "";
          const api = `https://trackmania.exchange/api/maps?name=${encodeURIComponent(q)}&count=25&fields=${encodeURIComponent("MapId,Name,Uploader.Name,AwardCount,Medals.Author")}`;
          const upstream = await fetch(api, { headers: { "User-Agent": "trackedit-dev" } });
          res.setHeader("content-type", "application/json");
          res.end(await upstream.text());
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      server.middlewares.use("/api/tmx/load", async (req, res) => {
        let dir: string | null = null;
        try {
          const id = (req.url ?? "").split("/").filter(Boolean).pop();
          if (!id || !/^\d+$/.test(id)) throw new Error("bad map id");
          const GBXDUMP = gbxdumpPath();
          const upstream = await fetch(`https://trackmania.exchange/maps/download/${id}`, {
            headers: { "User-Agent": "trackedit-dev" },
          });
          if (!upstream.ok) throw new Error(`TMX download ${upstream.status}`);
          dir = await mkdtemp(join(tmpdir(), "trackedit-tmx-"));
          const gbx = join(dir, "map.Map.Gbx");
          const out = join(dir, "map.json");
          await writeFile(gbx, Buffer.from(await upstream.arrayBuffer()));
          try {
            await convertMap(gbx, out, GBXDUMP);
          } catch (err) {
            const kept = join(tmpdir(), `trackedit-tmx-failed-${id}.Map.Gbx`);
            await copyFile(gbx, kept);
            throw new Error(`${err instanceof Error ? err.message : String(err)} (map kept at ${kept})`);
          }
          // Best-effort: pull the map's embedded custom blocks/items into the
          // mesh library so they render (meshdump joins names for us).
          await new Promise<void>((resolve) => {
            execFile(
              MESHDUMP,
              ["embedded", gbx, join(process.cwd(), "public", "meshes")],
              { timeout: 120_000 },
              (err, stdout) => {
                if (err) console.warn("[tmx] embedded extraction failed:", err.message);
                else if (stdout.trim()) console.log("[tmx]", stdout.trim());
                resolve();
              },
            );
          });
          // Attach the map's mod (custom texture pack) reference, if any.
          const mod = await new Promise<{ url?: string } | null>((resolve) => {
            execFile(MESHDUMP, ["modinfo", gbx], { timeout: 60_000 }, (err, stdout) => {
              if (err) return resolve(null);
              try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
            });
          });
          const dump = JSON.parse(await readFile(out, "utf-8"));
          if (mod?.url) dump.mod = mod;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(dump));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        } finally {
          if (dir) void rm(dir, { recursive: true, force: true });
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
            execFile(MESHDUMP, ["modpack", zipPath, outDir], { timeout: 300_000 },
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
  const readCfg = async (): Promise<{ openplanetDir?: string }> => {
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
    const haveExe = await isFile(MESHDUMP);
    const runOne = (cmd: string) =>
      new Promise<void>((resolve, reject) => {
        const args = [cmd, extractRoot, meshesDir];
        // First run has no built exe — `dotnet run` builds it (needs .NET 8 SDK).
        const child = haveExe
          ? spawn(MESHDUMP, args)
          : spawn("dotnet", ["run", "-c", "Release", "--project", join("tools", "meshdump"), "--", ...args]);
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
            res.end(JSON.stringify({
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
  plugins: [tmxBridge(), mapStoreBridge(), debugBridge(), modsBridge(), setupBridge(), liveBridge()],
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
