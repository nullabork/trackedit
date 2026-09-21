import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createMapConverter } from "./mapConverter";

/**
 * A downloaded .Map.Gbx -> the dump JSON the editor imports. One path for every
 * source (TMX, a Nadeo-hosted map a club room is playing): keep the original as
 * the save-back template, convert, pull embedded custom blocks into the mesh
 * library, attach the mod reference and the map's own validation ghost.
 */
export type MapLoader = (bytes: Buffer, opts: { keepAs: string; label: string }) => Promise<Record<string, unknown>>;

export function createMapLoader(opts: { root: string; meshdump: string; gbxdump: () => string }): MapLoader {
  const convertMap = createMapConverter(opts.root);
  const meshdumpJson = <T>(args: string[], timeout: number, fromFile?: string) =>
    new Promise<T | null>((resolve) => {
      execFile(opts.meshdump, args, { timeout, windowsHide: true }, async (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(fromFile ? await readFile(fromFile, "utf-8") : stdout) as T); } catch { resolve(null); }
      });
    });

  return async (bytes, { keepAs, label }) => {
    const dir = await mkdtemp(join(tmpdir(), "trackedit-map-"));
    try {
      const gbx = join(dir, "map.Map.Gbx");
      const out = join(dir, "map.json");
      await writeFile(gbx, bytes);
      // Keep the original: it is the template when this track is saved
      // back to the game (tools/gameBridge.ts).
      await mkdir(dirname(keepAs), { recursive: true });
      await copyFile(gbx, keepAs);
      try {
        await convertMap(gbx, out, opts.gbxdump());
      } catch (err) {
        const kept = join(tmpdir(), `trackedit-failed-${label}.Map.Gbx`);
        await copyFile(gbx, kept);
        throw new Error(`${err instanceof Error ? err.message : String(err)} (map kept at ${kept})`);
      }
      // Best-effort: pull the map's embedded custom blocks/items into the
      // mesh library so they render (meshdump joins names for us).
      await new Promise<void>((resolve) => {
        execFile(opts.meshdump, ["embedded", gbx, join(opts.root, "public", "meshes")],
          { timeout: 120_000, windowsHide: true }, (err, stdout) => {
            if (err) console.warn("[map] embedded extraction failed:", err.message);
            else if (stdout.trim()) console.log("[map]", stdout.trim());
            resolve();
          });
      });
      const dump = JSON.parse(await readFile(out, "utf-8")) as Record<string, unknown>;
      // Attach the map's mod (custom texture pack) reference, if any.
      const mod = await meshdumpJson<{ url?: string }>(["modinfo", gbx], 60_000);
      if (mod?.url) dump.mod = mod;
      // The map's own validation ghost, when the author left one in.
      const ghostOut = join(dir, "ghost.json");
      const ghost = await meshdumpJson<Record<string, unknown>>(["ghost", gbx, ghostOut], 120_000, ghostOut);
      if (ghost) dump.ghost = { source: "map", ...ghost };
      return dump;
    } finally {
      void rm(dir, { recursive: true, force: true });
    }
  };
}
