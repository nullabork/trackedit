import type { Plugin } from "vite";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Saves the open track as a real .Map.Gbx inside the game's Maps folder.
 *
 *   GET  /api/game/status -> { mapsDir }  (null when Trackmania's folder was not found)
 *   POST /api/game/save   -> body { dump, docId, tmxId? } ; { path, blocks, items, … }
 *
 * The file is written by `meshdump build` from a TEMPLATE map: decoration,
 * embedded items, palette and metadata come from it. For a track opened from
 * TMX the template is the original map (cached at import under maps/gbx, or
 * downloaded again); otherwise `.trackedit.local.json` names one:
 *
 *   { "templateMap": "C:\\…\\Maps\\MyEmptyBase.Map.Gbx",
 *     "trackmaniaDir": "C:\\…\\Documents\\Trackmania" }   // optional override
 *
 * Shadows are NOT computed: the template's lightmap is dropped because it was
 * baked for other geometry. Compute them in the game (editor, or the Batch
 * Compute Shadows Openplanet plugin over the Maps/Trackedit folder).
 */
interface LocalCfg { trackmaniaDir?: string; templateMap?: string }

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

      server.middlewares.use("/api/game/save", async (req, res) => {
        let work: string | null = null;
        try {
          if (req.method !== "POST") return send(res, 405, { error: "POST only" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
            dump?: { mapName?: string } & Record<string, unknown>; docId?: string; tmxId?: number | null;
          };
          if (!body.dump || !body.docId) return send(res, 400, { error: "dump and docId required" });

          const tm = trackmaniaDir();
          if (!tm) return send(res, 404, { error: "Trackmania's Documents folder was not found — set trackmaniaDir in .trackedit.local.json" });

          // Template: the TMX original, else the configured base map.
          let template: string | null = null;
          if (body.tmxId) {
            template = tmxTemplatePath(body.tmxId);
            if (!existsSync(template)) {
              const r = await fetch(`https://trackmania.exchange/maps/download/${body.tmxId}`, { headers: { "User-Agent": "trackedit-dev" } });
              if (!r.ok) throw new Error(`TMX download ${r.status}`);
              await mkdir(join(process.cwd(), "maps", "gbx"), { recursive: true });
              await writeFile(template, Buffer.from(await r.arrayBuffer()));
            }
          } else {
            template = localCfg().templateMap ?? null;
            if (!template || !existsSync(template))
              return send(res, 400, { error: "This track did not come from TMX, so it needs a base map: set templateMap in .trackedit.local.json to any .Map.Gbx with the base you want (an empty map saved from the game editor works)." });
          }

          work = await mkdtemp(join(tmpdir(), "trackedit-save-"));
          const placements = join(work, "placements.json");
          await writeFile(placements, JSON.stringify({ ...body.dump, mapUid: mapUidFor(body.docId) }));
          const outDir = join(tm, "Maps", "Trackedit");
          const out = join(outDir, `${fileStem(body.dump.mapName ?? "track")}.Map.Gbx`);
          const result = await new Promise<string>((resolve, reject) =>
            execFile(meshdump, ["build", template!, placements, out], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
              (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout))));
          const line = result.trim().split("\n").pop() ?? "{}";
          send(res, 200, JSON.parse(line));
        } catch (err) {
          send(res, 502, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
        }
      });
    },
  };
}
