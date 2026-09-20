import type { Plugin } from "vite";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";

/**
 * Saves the open track as a real .Map.Gbx inside the game's Maps folder.
 *
 *   GET  /api/game/status -> { mapsDir }  (null when Trackmania's folder was not found)
 *   POST /api/game/save   -> body { dump, docId, tmxId?, atmosphere? } ; { path, blocks, items, notes, … }
 *   POST /api/game/sky?name=&doc= -> body = image bytes ; { file }   (custom sky images, kept under maps/sky)
 *   GET  /api/game/sky/<file>     -> the image
 *   GET  /api/game/mod/<name>.zip -> download a sun/sky mod this bridge wrote
 *   POST /api/game/mod/reveal     -> body { name } ; shows the zip in the file manager
 *   POST /api/game/mod/url        -> body { name, url, mapPath, force? } ; checks that the URL serves exactly
 *                                    that zip, then writes it into the map ; { verified, reason, written }
 *
 * The file is written by `meshdump build` from a TEMPLATE map: decoration,
 * embedded items, palette and metadata come from it. For a track opened from
 * TMX the template is the original map (cached at import under maps/gbx, or
 * downloaded again); otherwise `.trackedit.local.json` names one:
 *
 *   { "templateMap": "C:\\…\\Maps\\MyEmptyBase.Map.Gbx",
 *     "trackmaniaDir": "C:\\…\\Documents\\Trackmania" }   // optional override
 *
 * The map's custom sky and light (src/core/atmosphere.ts) ride along:
 * - the sun (and a sky image) become a mod zip in the game's
 *   Skins/Stadium/Mod folder that the map points at — `meshdump moodmod`
 *   writes the mood settings, `tools/sky_mod.py` (Python, numpy, Pillow) adds
 *   the sky image. The zip's name carries a hash of its content, so the game
 *   never shows a stale copy. A map has room for ONE mod: a template that
 *   already has a texture pack keeps it and the sun is skipped (reported).
 *   The zip is a local file, so only this machine sees the look — until the
 *   author uploads it and gives the map its URL (the editor's share dialog
 *   drives the /api/game/mod routes for that).
 * - fog becomes a MediaTracker clip (`meshdump atmosphere fog=…`). Its nodes
 *   are cloned from two donor maps fetched from TMX once and cached under
 *   maps/gbx (see FOG_DONORS).
 *
 * Shadows are NOT computed: the template's lightmap is dropped because it was
 * baked for other geometry. Compute them in the game (editor, or the Batch
 * Compute Shadows Openplanet plugin over the Maps/Trackedit folder).
 */
interface LocalCfg { trackmaniaDir?: string; templateMap?: string; openplanetDir?: string; python?: string }

/** TMX maps whose MediaTracker nodes the fog clip is cloned from: one with an in-game clip, one with a Fog block. */
const FOG_DONORS = { group: 84457, fog: 1 };

interface AtmosphereBody {
  sun?: { dayTime01: number; latitude: number; color: string | null; intensity: number; moonColor: string | null; moonIntensity: number } | null;
  fog?: { color: string; intensity: number; skyIntensity: number; distance: number; cloudsOpacity: number } | null;
  sky?: { image: string; exposure: number; clouds: "keep" | "clear" } | null;
  hosted?: { name: string; url: string } | null;
}

interface SunMod { name: string; ref: string; bytes: number }

const MOD_NAME = /^TrackeditSun_[A-Za-z0-9_]+\.zip$/;
const modFolder = (tm: string): string => join(tm, "Skins", "Stadium", "Mod");
const modRef = (name: string): string => ["Skins", "Stadium", "Mod", name].join("\\");

const skyDir = (): string => join(process.cwd(), "maps", "sky");
const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const run = (cmd: string, args: string[], timeout = 180_000): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout))));

/** A TMX map's original file, downloaded once into maps/gbx. */
async function tmxMapFile(tmxId: number): Promise<string> {
  const path = tmxTemplatePath(tmxId);
  if (!existsSync(path)) {
    const r = await fetch(`https://trackmania.exchange/maps/download/${tmxId}`, { headers: { "User-Agent": "trackedit-dev" } });
    if (!r.ok) throw new Error(`TMX download ${r.status}`);
    await mkdir(join(process.cwd(), "maps", "gbx"), { recursive: true });
    await writeFile(path, Buffer.from(await r.arrayBuffer()));
  }
  return path;
}

/**
 * Write the sun / sky mod for a map and return the path the map should
 * reference (relative to the game's user folder), or null when there is
 * nothing custom to write.
 */
async function writeSunMod(meshdump: string, tm: string, uid: string, atmosphere: AtmosphereBody, notes: string[]): Promise<SunMod | null> {
  const { sun, sky } = atmosphere;
  if (!sun && !sky) return null;
  const moods = join(localCfg().openplanetDir ?? join(homedir(), "OpenplanetNext"), "Extract", "GameData", "Stadium", "Media", "Moods");
  const modDir = modFolder(tm);
  await mkdir(modDir, { recursive: true });
  const stem = `TrackeditSun_${uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
  const building = `${stem}_building.zip`;
  const zip = join(modDir, building);
  const args = ["moodmod", moods, zip];
  if (sun) {
    args.push(`daytime01=${sun.dayTime01}`, `latitude=${sun.latitude}`, `sunX=${sun.intensity}`, `moonX=${sun.moonIntensity}`);
    if (sun.color) args.push(`sun=${sun.color}`);
    if (sun.moonColor) args.push(`moon=${sun.moonColor}`);
  }
  await run(meshdump, args);
  if (sky) {
    const image = join(skyDir(), safeName(sky.image));
    if (!existsSync(image)) notes.push("The sky image is missing from maps/sky, so the mood's own sky was kept.");
    else {
      try {
        await run(localCfg().python ?? "python", [join(process.cwd(), "tools", "sky_mod.py"), "--name", stem, "--panorama", image,
          "--exposure", String(sky.exposure), "--clouds", sky.clouds, "--out", zip, "--append"], 300_000);
      } catch (err) {
        const why = err instanceof Error ? err.message.trim().split(/\r?\n/).pop() : String(err);
        notes.push(`The sky image was not written (${why}) — it needs Python with numpy and Pillow.`);
      }
    }
  }
  // Content-addressed name: a changed look is a new file, so nothing stale is ever shown.
  const data = await readFile(zip);
  const name = `${stem}_${createHash("sha1").update(data).digest("hex").slice(0, 8)}.zip`;
  for (const old of await readdir(modDir))
    if (old.startsWith(`${stem}_`) && old !== building) await rm(join(modDir, old), { force: true });
  await writeFile(join(modDir, name), data);
  await rm(zip, { force: true });
  return { name, ref: modRef(name), bytes: data.length };
}

/** Does the URL serve exactly this file? (Share pages that wrap the file in HTML do not.) */
async function checkHosted(url: string, local: Buffer): Promise<{ verified: boolean; reason: string }> {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "trackedit-dev" }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return { verified: false, reason: `The link answered ${r.status}.` };
    const got = Buffer.from(await r.arrayBuffer());
    if (got.equals(local)) return { verified: true, reason: "The link serves exactly this file." };
    const html = got.subarray(0, 200).toString("utf-8").toLowerCase().includes("<html") || (r.headers.get("content-type") ?? "").includes("text/html");
    return {
      verified: false,
      reason: html
        ? "The link opens a web page, not the file itself. The game needs a direct download link."
        : `The link serves a different file (${got.length} bytes, expected ${local.length}). Upload the zip this save wrote.`,
    };
  } catch (err) {
    return { verified: false, reason: `The link could not be fetched (${err instanceof Error ? err.message : err}).` };
  }
}


const localCfg = (): LocalCfg => {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), ".trackedit.local.json"), "utf-8")) as LocalCfg;
  } catch {
    return {};
  }
};

/** The game's user folder (the one holding Maps/), or null. */
export function trackmaniaDir(): string | null {
  const home = homedir();
  const candidates = [
    localCfg().trackmaniaDir,
    join(home, "Documents", "Trackmania"),
    join(home, "OneDrive", "Documents", "Trackmania"),
    join(home, "Documents", "Trackmania2020"),
    join(home, "OneDrive", "Documents", "Trackmania2020"),
  ];
  for (const c of candidates) if (c && existsSync(join(c, "Maps"))) return c;
  return null;
}

/** Cached copy of a TMX map's original file (written at import). */
export const tmxTemplatePath = (tmxId: string | number): string =>
  join(process.cwd(), "maps", "gbx", `tmx-${tmxId}.Map.Gbx`);

/** A stable 27-char map uid per editor document: re-saving overwrites the same map in game. */
export function mapUidFor(docId: string): string {
  return createHash("sha1").update(`trackedit:${docId}`).digest("base64url").slice(0, 27);
}

/** "$f70Isla$0afnder $fff[RPG]" -> "Islander [RPG]" -> a safe file stem. */
export function fileStem(name: string): string {
  const plain = name.replace(/\$([0-9a-f]{3}|[lhp]\[[^\]]*\]|.)/gi, "").trim();
  return (plain.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/[. ]+$/, "") || "track").slice(0, 80);
}

export function gameBridge(meshdump: string): Plugin {
  return {
    name: "game-bridge",
    configureServer(server) {
      const send = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };

      server.middlewares.use("/api/game/status", (_req, res) => {
        const dir = trackmaniaDir();
        send(res, 200, { mapsDir: dir ? join(dir, "Maps", "Trackedit") : null });
      });

      server.middlewares.use("/api/game/sky", async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          if (req.method === "POST") {
            const ext = extname(url.searchParams.get("name") ?? "").toLowerCase();
            if (!IMAGE_TYPES[ext]) return send(res, 400, { error: "PNG, JPEG or WebP images only" });
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const data = Buffer.concat(chunks);
            const file = safeName(`${url.searchParams.get("doc") ?? "map"}-${createHash("sha1").update(data).digest("hex").slice(0, 8)}${ext}`);
            await mkdir(skyDir(), { recursive: true });
            await writeFile(join(skyDir(), file), data);
            return send(res, 200, { file });
          }
          const file = safeName(decodeURIComponent(url.pathname.replace(/^\/+/, "")));
          const path = join(skyDir(), file);
          if (!file || !existsSync(path)) return send(res, 404, { error: "no such sky image" });
          res.statusCode = 200;
          res.setHeader("content-type", IMAGE_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
          res.end(await readFile(path));
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/game/mod", async (req, res) => {
        try {
          const tm = trackmaniaDir();
          if (!tm) return send(res, 404, { error: "Trackmania's Documents folder was not found" });
          const route = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.replace(/^\/+/, ""));
          const zipOf = (name: unknown): string | null => {
            if (typeof name !== "string" || !MOD_NAME.test(name)) return null;
            const path = join(modFolder(tm), name);
            return existsSync(path) ? path : null;
          };
          if (req.method === "GET") {
            const path = zipOf(route);
            if (!path) return send(res, 404, { error: "no such mod" });
            res.statusCode = 200;
            res.setHeader("content-type", "application/zip");
            res.setHeader("content-disposition", `attachment; filename="${route}"`);
            return res.end(await readFile(path));
          }
          if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") as { name?: string; url?: string; mapPath?: string; force?: boolean };
          const zip = zipOf(body.name);
          if (!zip) return send(res, 404, { error: "no such mod" });

          if (route === "reveal") {
            // Select the file where the platform can; otherwise open its folder.
            const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [`/select,${zip}`]]
              : process.platform === "darwin" ? ["open", ["-R", zip]]
              : ["xdg-open", [modFolder(tm)]];
            // explorer.exe exits 1 even on success, so the exit code says nothing.
            execFile(cmd as string, args as string[], () => {});
            return send(res, 200, { ok: true, folder: modFolder(tm) });
          }
          if (route === "url") {
            const url = (body.url ?? "").trim();
            if (!/^https?:\/\//i.test(url)) return send(res, 400, { error: "an http(s) link is required" });
            const mapsDir = join(tm, "Maps", "Trackedit");
            const mapPath = body.mapPath ?? "";
            if (!mapPath.startsWith(mapsDir) || mapPath.includes("..") || !existsSync(mapPath))
              return send(res, 400, { error: "the map has to be one this bridge saved" });
            const check = await checkHosted(url, await readFile(zip));
            if (!check.verified && !body.force) return send(res, 200, { ...check, written: false });
            await run(meshdump, ["atmosphere", mapPath, mapPath, `mod=${modRef(body.name!)}`, `modUrl=${url}`]);
            return send(res, 200, { ...check, written: true });
          }
          send(res, 404, { error: "unknown mod route" });
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/game/save", async (req, res) => {
        let work: string | null = null;
        try {
          if (req.method !== "POST") return send(res, 405, { error: "POST only" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
            dump?: { mapName?: string } & Record<string, unknown>; docId?: string; tmxId?: number | null; atmosphere?: AtmosphereBody | null;
          };
          if (!body.dump || !body.docId) return send(res, 400, { error: "dump and docId required" });

          const tm = trackmaniaDir();
          if (!tm) return send(res, 404, { error: "Trackmania's Documents folder was not found — set trackmaniaDir in .trackedit.local.json" });

          // Template: the TMX original, else the configured base map.
          let template: string | null = null;
          if (body.tmxId) {
            template = await tmxMapFile(body.tmxId);
          } else {
            template = localCfg().templateMap ?? null;
            if (!template || !existsSync(template))
              return send(res, 400, { error: "This track did not come from TMX, so it needs a base map: set templateMap in .trackedit.local.json to any .Map.Gbx with the base you want (an empty map saved from the game editor works)." });
          }

          work = await mkdtemp(join(tmpdir(), "trackedit-save-"));
          const placements = join(work, "placements.json");
          const notes: string[] = [];
          const uid = mapUidFor(body.docId);
          const atmosphere = body.atmosphere ?? {};
          const sunMod = await writeSunMod(meshdump, tm, uid, atmosphere, notes);
          // An upload the author already confirmed for this exact zip rides along.
          const hostedUrl = sunMod && atmosphere.hosted?.name === sunMod.name ? atmosphere.hosted.url : null;
          await writeFile(placements, JSON.stringify({ ...body.dump, mapUid: uid, ...(sunMod ? { sunMod: sunMod.ref, sunModUrl: hostedUrl ?? "" } : {}) }));
          const outDir = join(tm, "Maps", "Trackedit");
          const out = join(outDir, `${fileStem(body.dump.mapName ?? "track")}.Map.Gbx`);
          const result = await run(meshdump, ["build", template!, placements, out]);
          const summary = JSON.parse(result.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
          if (summary.sunModSkipped) notes.push("This map already uses a texture pack, and a map has room for one mod only: the custom sun and sky were not written.");
          else if (sunMod) notes.push("Custom sun and sky written — compute shadows in the game to bake the light in.");
          const written = sunMod && !summary.sunModSkipped ? { name: sunMod.name, bytes: sunMod.bytes, url: hostedUrl } : null;

          const fog = atmosphere.fog;
          if (fog && fog.intensity > 0) {
            const rgb = [1, 3, 5].map((i) => (parseInt(fog.color.slice(i, i + 2), 16) / 255).toFixed(4)).join(",");
            await run(meshdump, ["atmosphere", out, out, `fog=${rgb}`, `intensity=${fog.intensity}`, `sky=${fog.skyIntensity}`,
              `distance=${fog.distance}`, `clouds=${fog.cloudsOpacity}`,
              `groupDonor=${await tmxMapFile(FOG_DONORS.group)}`, `fogDonor=${await tmxMapFile(FOG_DONORS.fog)}`]);
            notes.push("Fog clip written.");
          }
          send(res, 200, { ...summary, notes, sunMod: written });
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
        }
      });
    },
  };
}
