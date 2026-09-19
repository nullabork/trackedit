import { execFile } from "node:child_process";
import { join } from "node:path";

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
 * pivots, scale, …), so it always runs first. An external converter
 * (`TRACKEDIT_GBXDUMP` / `.trackedit.local.json` `gbxdump`) is the fallback
 * for machines where the bundled one cannot build or run — an older
 * external dump would otherwise silently drop fields the editor needs.
 */
export function createMapConverter(root: string) {
  let build: Promise<void> | undefined;
  const bundled = async (input: string, output: string): Promise<void> => {
    build ??= run("dotnet", ["build", join(root, "tools", "meshdump", "meshdump.csproj"),
      "--configuration", "Release", "--nologo"], 300_000).catch(error => {
      build = undefined;
      throw error;
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
  };
}
