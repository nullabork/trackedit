import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a map dump must carry for the editor to place things correctly. A
 * converter that omits these does not fail — it yields a map that LOOKS
 * imported while every pivoted item sits half a piece off and every block
 * draws its base variant. So a dump is checked before it is used.
 */
/** Every field `meshdump map` writes per record (tools/meshdump/MapDump.cs). A key may hold null; it may not be missing. */
export const DUMP_FIELDS = {
  map: ["mapName", "mapUid", "decoration", "colorPalette", "blocks", "items"],
  block: ["idx", "name", "coord", "dir", "isGround", "isClip", "isFree", "absPos", "yawPitchRoll", "flags", "variant", "subVariant", "color", "lightmapQuality", "waypoint", "skin"],
  item: ["idx", "name", "itemAuthor", "absPos", "yawPitchRoll", "pivotPos", "scale", "flags", "color", "lightmapQuality", "waypoint"],
} as const;

export function dumpProblems(dump: Record<string, unknown> & { blocks?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> }): string[] {
  const problems: string[] = [];
  const missing = (records: Array<Record<string, unknown>>, fields: readonly string[]) =>
    fields.filter((f) => records.some((r) => !(f in r)));
  const top = DUMP_FIELDS.map.filter((f) => !(f in dump));
  if (top.length) problems.push(`the map record lacks ${top.join(", ")}`);
  const block = missing(dump.blocks ?? [], DUMP_FIELDS.block);
  if (block.length) problems.push(`blocks lack ${block.join(", ")}`);
  const item = missing(dump.items ?? [], DUMP_FIELDS.item);
  if (item.length) problems.push(`items lack ${item.join(", ")}`);
  return problems;
}

const verifyFile = (output: string): string[] => dumpProblems(JSON.parse(readFileSync(output, "utf-8")));

function run(file: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve();
      if (file === "dotnet" && error.code === "ENOENT") {
        return reject(new Error("Map import requires the .NET 8 SDK. Install it and retry, or configure TRACKEDIT_GBXDUMP with a standalone converter."));
      }
      const detail = [stderr, stdout].map(s => s.trim()).filter(Boolean).join(" | ");
      reject(new Error(`Map converter failed: ${detail || error.message}`));
    });
  });
}

/** Build once per server session, sharing the build across concurrent imports.
 * Failed builds can be retried after the user fixes the SDK/dependencies.
 * Run the managed DLL so no OS-specific apphost or executable suffix is needed.
 *
 * The bundled converter defines the JSON dialect the editor reads (item
 * pivots, block flags and indices, …), so it always runs first. When its
 * BUILD fails but an earlier build is there (its files are locked while
 * another meshdump runs), that one is used. An external converter
 * (`TRACKEDIT_GBXDUMP` / `.trackedit.local.json` `gbxdump`) is the fallback
 * for machines where the bundled one cannot run at all — and its output is
 * checked (`dumpProblems`): a dump without the fields the editor places by
 * is refused with the reason, never imported quietly. That happened: a
 * locked build sent a 31,000-placement map through an old external dump
 * and all 6,691 items lost their pivots.
 */
export function createMapConverter(
  root: string,
  { verify = verifyFile, hasBuild = existsSync }: { verify?: (output: string) => string[]; hasBuild?: (dll: string) => boolean } = {},
) {
  let build: Promise<void> | undefined;
  const dll = join(root, "tools", "meshdump", "bin", "Release", "net8.0", "meshdump.dll");
  const bundled = async (input: string, output: string): Promise<void> => {
    build ??= run("dotnet", ["build", join(root, "tools", "meshdump", "meshdump.csproj"),
      "--configuration", "Release", "--nologo"], 300_000).catch(error => {
      build = undefined;
      // Without dotnet itself there is nothing to run an earlier build with.
      const noSdk = error instanceof Error && error.message.includes(".NET 8 SDK");
      if (noSdk || !hasBuild(dll)) throw error;
      console.warn(`[map] the converter could not be rebuilt (${error instanceof Error ? error.message.slice(0, 120) : error}); using the existing build`);
    });
    await build;
    await run("dotnet", [join(root, "tools", "meshdump", "bin", "Release", "net8.0", "meshdump.dll"),
      "map", input, output], 120_000);
  };
  return async (input: string, output: string, override?: string): Promise<void> => {
    try {
      await bundled(input, output);
    } catch (error) {
      if (!override) throw error;
      console.warn(`[map] bundled converter failed (${error instanceof Error ? error.message : error}); using ${override}`);
      await run(override, [input, output], 120_000);
    }
    const problems = verify(output);
    if (problems.length)
      throw new Error(`The map converter's output is missing what the editor places by: ${problems.join("; ")}. ` +
        "An outdated external converter ran — fix the bundled one (tools/meshdump, needs the .NET 8 SDK) and import again.");
  };
}
