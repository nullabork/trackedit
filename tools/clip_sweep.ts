/**
 * Developer check: every block's clips against the game's own, block by block.
 *
 * tools/TrackeditTruth's sweep places each block of the game alone in an empty
 * map and records the clip blocks the editor generates around it (a lone block
 * shows all of them), relative to the block. This compares that table with
 * what the extractor put into public/meshes/index.json:
 *
 * - blocks whose clip list differs (a clip the game has and we lack, or the
 *   reverse, by name and cell);
 * - for top/bottom clips, the direction the game gives each one relative to
 *   its block — the ground truth for the extractor's cap shape-fit. Written to
 *   a JSON table so the extractor can use it instead of fitting.
 *
 * Where the game puts a clip block (the unit's own cell or the cell it faces)
 * is measured over the whole sweep, not assumed.
 *
 * usage: npx tsx tools/clip_sweep.ts [sweep.json] [capdirs-out.json]   (npm run clipsweep)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FACE_NORMAL } from "../src/render/clipAdjacency";
import type { UnitClip } from "../src/render/clipAdjacency";

interface SweepClip { name: string; rel: [number, number, number]; dir: number }
interface SweepResult { name: string; where: "air" | "ground"; placed: boolean; found?: boolean; dir?: number; clips?: SweepClip[]; others?: SweepClip[] }

const sweepPath = process.argv[2] ?? join(process.env.OPENPLANET_DIR ?? join(homedir(), "OpenplanetNext"), "PluginStorage", "TrackeditTruth", "sweep.json");
if (!existsSync(sweepPath)) {
  console.error(`no sweep at ${sweepPath}\nIn the game: new EMPTY map in the editor, then Openplanet > Plugins > "Trackedit Truth (sweep every block)".`);
  process.exit(2);
}
const sweep = JSON.parse(readFileSync(sweepPath, "utf-8")) as { models: number; complete: boolean; results: SweepResult[] };
type Entry = { clips?: Record<string, UnitClip[] | null> };
const index = (JSON.parse(readFileSync(join(process.cwd(), "public", "meshes", "index.json"), "utf-8")) as { blocks: Record<string, Entry> }).blocks;

const usable = sweep.results.filter((r) => r.placed && r.found && r.dir === 0);
console.log(`${sweep.results.length} placements (${sweep.complete ? "complete" : "STOPPED EARLY"}): ${usable.length} usable, ` +
  `${sweep.results.filter((r) => !r.placed).length} could not be placed, ${sweep.results.filter((r) => r.placed && !r.found).length} not found after placing`);

const key = (name: string, c: readonly number[]) => `${name}@${c[0]},${c[1]},${c[2]}`;
const cellsOf = (clips: UnitClip[], faced: boolean) => clips.map((c) => {
  const n = faced ? FACE_NORMAL[c.face] : [0, 0, 0];
  return key(c.id, [c.u[0] + n[0], c.u[1] + n[1], c.u[2] + n[2]]);
});

// Own cell or faced cell? Count matches both ways over everything.
let own = 0, faced = 0;
for (const r of usable) {
  const ours = index[r.name]?.clips?.[r.where];
  if (!ours) continue;
  const game = new Set((r.clips ?? []).map((c) => key(c.name, c.rel)));
  own += cellsOf(ours, false).filter((k) => game.has(k)).length;
  faced += cellsOf(ours, true).filter((k) => game.has(k)).length;
}
const useFaced = faced > own;
console.log(`clip cells: ${own} match in the unit's own cell, ${faced} in the cell it faces -> "${useFaced ? "faced" : "own"}"`);

let same = 0, unknown = 0;
const differing: string[] = [];
const capDirs: Record<string, Record<string, number>> = {};
for (const r of usable) {
  const ours = index[r.name]?.clips?.[r.where];
  if (!ours) { unknown++; continue; }
  const mine = cellsOf(ours, useFaced).sort(), game = (r.clips ?? []).map((c) => key(c.name, c.rel)).sort();
  const missing = game.filter((k) => !mine.includes(k)), extra = mine.filter((k) => !game.includes(k));
  if (!missing.length && !extra.length) same++;
  else differing.push(`${r.name} [${r.where}]  game-only: ${missing.join(" ") || "-"}   ours-only: ${extra.join(" ") || "-"}`);
  ours.forEach((c) => {
    if (c.face !== "top" && c.face !== "bottom") return;
    const g = (r.clips ?? []).find((x) => key(x.name, x.rel) === cellsOf([c], useFaced)[0]);
    if (g) (capDirs[`${r.name}|${r.where}`] ??= {})[`${c.id}:${c.face}:${c.u.join(",")}`] = g.dir;
  });
}
console.log(`clip lists: ${same} blocks identical, ${differing.length} differ, ${unknown} not in our index`);
for (const d of differing.slice(0, 40)) console.log(`   ${d}`);
if (differing.length > 40) console.log(`   ... and ${differing.length - 40} more`);

const turned = Object.entries(capDirs).flatMap(([b, m]) => Object.entries(m).filter(([, d]) => d !== 0).map(([c, d]) => `${b} ${c} -> ${d * 90}deg`));
console.log(`caps: ${Object.values(capDirs).reduce((n, m) => n + Object.keys(m).length, 0)} matched, ${turned.length} turned relative to their block`);
for (const t of turned.slice(0, 40)) console.log(`   ${t}`);
const out = process.argv[3] ?? join(process.cwd(), "sheets", "capdirs.json");
writeFileSync(out, JSON.stringify(capDirs, null, 1));
console.log(`cap directions written to ${out}`);
process.exit(differing.length ? 1 : 0);
