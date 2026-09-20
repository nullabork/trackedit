/**
 * Developer check: are blocks and their variants set up correctly?
 *
 * For every .Map.Gbx given (default: every map cached under maps/gbx), runs
 * `meshdump variantcheck` — each placed block names a variant of its block
 * (air/ground + an index, from the map file's flags); that variant has to
 * exist in the game's definition, and the mesh extraction under
 * public/meshes has to know it (otherwise the editor shows the base look).
 *
 * Then the part that guards against blocks drawn mirrored or with the wrong
 * underside: the map goes through the EDITOR'S OWN import, and for every
 * placement the variant the editor would draw (core/layer.ts
 * placementVariant) is compared with the variant the map file names. Any
 * difference is listed by block name.
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
import { MapDocument } from "../src/core/document";
import { placementMobil, placementVariant } from "../src/core/layer";
import { baseTypeOf } from "../src/core/mapbase";
import { importDump, type MapDump } from "../src/io/trackoJson";

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

/** Placement by placement: what the editor draws against what the file says. */
type MobilReport = { named: number; noTable: number; wrong: Map<string, number> };
const meshIndex = (JSON.parse(readFileSync(join(meshes, "index.json"), "utf-8")) as { blocks: Record<string, { mobils?: Record<string, number[]> }> }).blocks;

function compareWithEditor(map: string, work: string): { checked: number; wrong: Map<string, number>; examples: string[]; mobils: MobilReport } {
  const dumpPath = join(work, "dump.json");
  execFileSync(MESHDUMP, ["map", map, dumpPath], { stdio: "ignore" });
  const dump = JSON.parse(readFileSync(dumpPath, "utf-8")) as MapDump & { blocks: Array<Record<string, unknown>> };
  const doc = new MapDocument();
  const imported = importDump(dump);
  doc.reset(imported.layers, { name: imported.name, decoration: imported.decoration });
  const stadium = baseTypeOf(doc.decorationBase) === "stadium";
  const wrong = new Map<string, number>();
  const mobils = { named: 0, noTable: 0, wrong: new Map<string, number>() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const examples: string[] = [];
  let checked = 0;
  for (const layer of doc.layers) for (const p of layer.placements.values()) {
    // Grid blocks AND free blocks: both name a variant (items do not).
    if (p.kind !== "block" && !(p.kind === "free" && !p.isItem)) continue;
    const original = dump.blocks[Number((p.meta as { idx?: number } | undefined)?.idx)];
    if (!original || original.name !== p.block) continue;
    checked++;
    const index = (Number(original.flags ?? 0) >>> 21) & 0x3f;
    const file = (original.isGround ? "ground" : "air") + (index || "");
    const editor = placementVariant(p, stadium);
    // The mobil it names (Variant = row, SubVariant = column) must exist in that variant's table.
    const row = Number(original.variant ?? 0), col = Number(original.subVariant ?? 0);
    if (row || col) {
      mobils.named++;
      const want = `${row}_${col}`;
      if (placementMobil(p) !== want) bump(mobils.wrong, `${p.block}: file ${want}, editor ${placementMobil(p) || "0_0"}`);
      const table = meshIndex[p.block]?.mobils;
      if (!table) mobils.noTable++;
      else {
        const cols = (table[editor] ?? table[editor.startsWith("ground") ? "ground" : "air"]) as number[] | undefined;
        if (!cols || row >= cols.length || col >= Math.max(cols[row], 1)) bump(mobils.wrong, `${p.block} [${editor}]: names mobil ${want}, its table is ${JSON.stringify(cols ?? null)}`);
      }
    }
    if (file === editor) continue;
    const key = `${p.block}: file ${file}, editor ${editor}`;
    wrong.set(key, (wrong.get(key) ?? 0) + 1);
    if (examples.length < 3) examples.push(`${p.block} at ${(p.kind === "block" ? p.coord : p.pos).join(",")}`);
  }
  return { checked, wrong, examples, mobils };
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
    const editor = compareWithEditor(map, work);
    const bad = r.outOfRange > 0 || r.notExtracted > 0 || editor.wrong.size > 0 || editor.mobils.wrong.size > 0;
    if (bad) failed++;
    const variants = Object.entries(r.byVariant).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(", ");
    console.log(`${bad ? "FAIL" : "ok  "} ${map}\n     ${r.blocks - r.custom - r.undefinedBlocks} blocks checked (${r.custom} custom, ${r.undefinedBlocks} undefined skipped): ${variants}`);
    const mismatches = [...editor.wrong.values()].reduce((a, b) => a + b, 0);
    console.log(`     editor vs file: ${editor.checked} blocks (grid and free) compared, ${mismatches} drawn with another variant than the file names`);
    for (const [what, n] of [...editor.wrong].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`       ${n} x ${what}`);
    const m = editor.mobils;
    console.log(`     mobils: ${m.named} blocks name one other than [0][0]; ${[...m.wrong.values()].reduce((a, b) => a + b, 0)} wrong or outside their table` +
      (m.noTable ? `; ${m.noTable} of blocks extracted before mobil tables existed (re-extract blocks)` : ""));
    for (const [what, n] of [...m.wrong].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`       ${n} x ${what}`);
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
