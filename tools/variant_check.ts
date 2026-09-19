/**
 * Developer check: are blocks and their variants set up correctly?
 *
 * For every .Map.Gbx given (default: every map cached under maps/gbx), runs
 * `meshdump variantcheck` — each placed block names a variant of its block
 * (air/ground + an index, from the map file's flags); that variant has to
 * exist in the game's definition, and the mesh extraction under
 * public/meshes has to know it (otherwise the editor shows the base look).
 *
 * Fails when any block names a variant its definition lacks (the flags are
 * being read wrong) or one the extraction has not got (re-run `meshdump
 * blocks`). Not an editor feature: tooling for whoever maintains the import.
 *
 * usage: npx tsx tools/variant_check.ts [map.Map.Gbx ...]     (npm run variantcheck)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MESHDUMP = process.env.TRACKEDIT_MESHDUMP ??
  join(process.cwd(), "tools", "meshdump", "bin", "Release", "net8.0", process.platform === "win32" ? "meshdump.exe" : "meshdump");
const localCfg = (): { openplanetDir?: string } => {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), ".trackedit.local.json"), "utf-8"));
  } catch {
    return {};
  }
};
const gameData = join(localCfg().openplanetDir ?? join(homedir(), "OpenplanetNext"), "Extract", "GameData", "Stadium");
const meshes = join(process.cwd(), "public", "meshes");

interface Report {
  map: string;
  blocks: number;
  custom: number;
  undefinedBlocks: number;
  outOfRange: number;
  notExtracted: number;
  byVariant: Record<string, number>;
  perBlock: Record<string, { notExtracted: string[] }>;
}

const maps = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(join(process.cwd(), "maps", "gbx")).filter((f) => f.endsWith(".Map.Gbx")).map((f) => join(process.cwd(), "maps", "gbx", f));
const work = mkdtempSync(join(tmpdir(), "trackedit-variants-"));
let failed = 0;
try {
  for (const map of maps) {
    const reportPath = join(work, "report.json");
    try {
      execFileSync(MESHDUMP, ["variantcheck", map, gameData, meshes, reportPath], { stdio: "ignore" });
    } catch { /* exit code 2 = problems; the report says which */ }
    const r = JSON.parse(readFileSync(reportPath, "utf-8")) as Report;
    const bad = r.outOfRange > 0 || r.notExtracted > 0;
    if (bad) failed++;
    const variants = Object.entries(r.byVariant).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(", ");
    console.log(`${bad ? "FAIL" : "ok  "} ${map}\n     ${r.blocks - r.custom - r.undefinedBlocks} blocks checked (${r.custom} custom, ${r.undefinedBlocks} undefined skipped): ${variants}`);
    if (r.outOfRange) console.log(`     ${r.outOfRange} name a variant their definition does not have`);
    if (r.notExtracted) {
      const stale = Object.entries(r.perBlock).filter(([, b]) => b.notExtracted.length).map(([name, b]) => `${name} (${b.notExtracted.join(", ")})`);
      console.log(`     ${r.notExtracted} use a variant the extraction lacks: ${stale.slice(0, 10).join(", ")}${stale.length > 10 ? ", …" : ""}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `${failed} of ${maps.length} maps have variant problems` : `all ${maps.length} maps check out`);
process.exit(failed ? 1 : 0);
