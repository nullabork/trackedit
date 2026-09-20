/**
 * Developer check: trackedit's clip pieces against the game's own.
 *
 * Around every block the game generates clip blocks (undersides, top plates,
 * side walls, end caps). Map files do not store them, so two things are
 * worked out on our side: which clip pieces show given a block's neighbours
 * (src/render/clipAdjacency.ts) and which way a top/bottom piece faces inside
 * its block (the extractor's shape fit). The Openplanet plugin in
 * tools/TrackeditTruth dumps what the game decided for the map open in its
 * editor; this compares the two, clip by clip:
 *
 * - shown by us, absent in the game  -> we draw a surface the game does not;
 * - present in the game, hidden by us -> a surface or shell is missing;
 * - per clip name, the game's direction relative to its block -> the ground
 *   truth for cap orientation, to check the extractor's turns against.
 *
 * Where the game puts a clip block (the unit's own cell or the cell it faces)
 * is measured rather than assumed: both are tried and the better one is used.
 *
 * usage: npx tsx tools/clip_truth.ts <map.Map.Gbx> [clips-<uid>.json]   (npm run cliptruth)
 *        without a dump path the newest one in the plugin's storage folder is used.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MapDocument } from "../src/core/document";
import { placementVariant } from "../src/core/layer";
import type { GridCoord } from "../src/core/math";
import { baseTypeOf } from "../src/core/mapbase";
import { importDump, type MapDump } from "../src/io/trackoJson";
import { FACE_NORMAL, cellKey, clipPartName, hiddenClipParts, occupiedCells, rotateByDir, unitCell } from "../src/render/clipAdjacency";
import type { BlockClipInfo, ClipSubject, UnitClip } from "../src/render/clipAdjacency";

const MESHDUMP = process.env.TRACKEDIT_MESHDUMP ??
  join(process.cwd(), "tools", "meshdump", "bin", "Release", "net8.0", process.platform === "win32" ? "meshdump.exe" : "meshdump");
const STORAGE = join(process.env.OPENPLANET_DIR ?? join(homedir(), "OpenplanetNext"), "PluginStorage", "TrackeditTruth");

interface TruthBlock { name: string; coord: GridCoord; dir: number; ghost: boolean }
interface Truth { mapUid: string; mapName: string; clips: TruthBlock[]; blocks: TruthBlock[] }

type Entry = { size?: [number, number, number]; units?: Record<string, [number, number, number][] | null>; clips?: Record<string, BlockClipInfo["clips"] | null> };
const index = (JSON.parse(readFileSync(join(process.cwd(), "public", "meshes", "index.json"), "utf-8")) as { blocks: Record<string, Entry> }).blocks;

/** Same fallbacks as MeshProvider.blockClips. */
function clipInfo(block: string, variant: string): BlockClipInfo | undefined {
  const entry = index[block];
  if (!entry) return undefined;
  const base = variant.startsWith("ground") ? "ground" : "air", other = base === "air" ? "ground" : "air";
  return {
    size: entry.size ?? [1, 1, 1],
    units: entry.units?.[variant] ?? entry.units?.[base] ?? entry.units?.[other] ?? [],
    clips: entry.clips?.[variant] ?? entry.clips?.[base] ?? entry.clips?.[other] ?? [],
  };
}

const [mapPath, givenDump] = process.argv.slice(2);
if (!mapPath) {
  console.error("usage: npx tsx tools/clip_truth.ts <map.Map.Gbx> [clips-<uid>.json]");
  process.exit(2);
}
const dumpFile = givenDump ?? (existsSync(STORAGE)
  ? readdirSync(STORAGE).filter((f) => /^clips-.*\.json$/.test(f)).map((f) => join(STORAGE, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  : undefined);
if (!dumpFile || !existsSync(dumpFile)) {
  console.error(`no clip dump found in ${STORAGE}\nOpen the map in the game's editor and run "Trackedit Truth (dump clip blocks)" from the Openplanet Plugins menu.`);
  process.exit(2);
}
const truth = JSON.parse(readFileSync(dumpFile, "utf-8")) as Truth;

const work = mkdtempSync(join(tmpdir(), "trackedit-truth-"));
let doc: MapDocument;
try {
  const dumpPath = join(work, "dump.json");
  execFileSync(MESHDUMP, ["map", mapPath, dumpPath], { stdio: "ignore" });
  doc = new MapDocument();
  const imported = importDump(JSON.parse(readFileSync(dumpPath, "utf-8")) as MapDump);
  doc.reset(imported.layers, { name: imported.name, decoration: imported.decoration });
} finally {
  rmSync(work, { recursive: true, force: true });
}
const stadium = baseTypeOf(doc.decorationBase) === "stadium";

/** Placed in ghost mode (flag bit 28): outside the editor's grid, which is how such blocks can overlap others. */
const isGhost = (meta: unknown): boolean => ((((meta as { flags?: number } | undefined)?.flags ?? 0) >>> 28) & 1) === 1;
type Subject = ClipSubject & { block: string; ghost: boolean };
const subjects: Subject[] = [];
for (const layer of doc.layers) for (const p of layer.placements.values()) {
  if (p.kind !== "block") continue;
  const info = clipInfo(p.block, placementVariant(p, stadium));
  if (info) subjects.push({ pose: { coord: p.coord, dir: p.dir }, info, block: p.block, ghost: isGhost(p.meta) });
}

// Is the dump of this map at all? Compare the ordinary blocks first.
const ours = new Map<string, number>();
for (const s of subjects) ours.set(`${s.block}@${cellKey(s.pose.coord)}`, (ours.get(`${s.block}@${cellKey(s.pose.coord)}`) ?? 0) + 1);
function blockOverlap(shift: number): number {
  let n = 0;
  for (const b of truth.blocks) if (ours.has(`${b.name}@${cellKey([b.coord[0], b.coord[1] + shift, b.coord[2]])}`)) n++;
  return n;
}
// The editor API and the file disagree on the level origin by a constant; measure it.
const shifts = [-2, -1, 0, 1, 2].map((s) => [s, blockOverlap(s)] as const).sort((a, b) => b[1] - a[1]);
const [yShift, matchedBlocks] = shifts[0];
console.log(`${truth.mapName} (${truth.mapUid}): game ${truth.blocks.length} blocks + ${truth.clips.length} clip blocks; ours ${subjects.length} blocks`);
console.log(`  blocks found at the same cell: ${matchedBlocks} of ${truth.blocks.length} (level shift ${yShift})`);
if (matchedBlocks < truth.blocks.length * 0.8) {
  console.error("  under 80% — this dump is of another map, or of another version of it");
  process.exit(2);
}

const cells = new Map<string, Subject[]>();
for (const s of subjects) for (const c of occupiedCells(s)) {
  const k = cellKey(c);
  (cells.get(k) ?? cells.set(k, []).get(k)!).push(s);
}

/** The game's clip blocks by name and cell; each one can be claimed once. */
const gameClips = new Map<string, TruthBlock[]>();
for (const c of truth.clips) {
  const k = `${c.name}@${cellKey([c.coord[0], c.coord[1] + yShift, c.coord[2]])}`;
  (gameClips.get(k) ?? gameClips.set(k, []).get(k)!).push(c);
}

interface OurClip { subject: Subject; clip: UnitClip; own: GridCoord; faced: GridCoord; hidden: boolean; hiddenOffGrid: boolean }
const all: OurClip[] = [];
for (const s of subjects) {
  const gone = hiddenClipParts(s, (cell) => (cells.get(cellKey(cell)) ?? []).filter((o) => o !== s));
  // The competing rule: ghost blocks are off the grid — they keep every clip and hide nobody else's.
  const offGrid = s.ghost ? new Set<string>() : hiddenClipParts(s, (cell) => (cells.get(cellKey(cell)) ?? []).filter((o) => o !== s && !o.ghost));
  for (const clip of s.info.clips) {
    const own = unitCell(s.pose, s.info.size, clip.u);
    const n = rotateByDir(FACE_NORMAL[clip.face], s.pose.dir);
    all.push({ subject: s, clip, own, faced: [own[0] + n[0], own[1] + n[1], own[2] + n[2]], hidden: gone.has(clipPartName(clip)), hiddenOffGrid: offGrid.has(clipPartName(clip)) });
  }
}

// Where does the game put a clip block: in the unit's cell or the cell it faces?
const count = (pick: (c: OurClip) => GridCoord) => all.filter((c) => gameClips.has(`${c.clip.id}@${cellKey(pick(c))}`)).length;
const inOwn = count((c) => c.own), inFaced = count((c) => c.faced);
const where = inFaced > inOwn ? "faced" : "own";
console.log(`  our clip names found in the game's list: ${inOwn} in the unit's own cell, ${inFaced} in the cell it faces -> using "${where}"`);
if (!Math.max(inOwn, inFaced)) {
  const names = [...new Set(truth.clips.map((c) => c.name))].slice(0, 12);
  console.error(`  nothing matches — the game's clip names look like: ${names.join(", ")}`);
  process.exit(2);
}

let agree = 0, agreeOffGrid = 0;
const byKind = { ghost: { n: 0, agree: 0, offGrid: 0 }, normal: { n: 0, agree: 0, offGrid: 0 } };
const extra = new Map<string, number>(), missing = new Map<string, number>(), dirs = new Map<string, Map<number, number>>();
const claimed = new Set<TruthBlock>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
for (const c of all) {
  const list = gameClips.get(`${c.clip.id}@${cellKey(where === "own" ? c.own : c.faced)}`) ?? [];
  const game = list.find((g) => !claimed.has(g));
  if (game) claimed.add(game);
  const kind = byKind[c.subject.ghost ? "ghost" : "normal"];
  kind.n++;
  if (!!game === !c.hiddenOffGrid) { agreeOffGrid++; kind.offGrid++; }
  if (!!game === !c.hidden) { agree++; kind.agree++; }
  else if (game) bump(missing, `${c.clip.id} (${c.clip.face}) of ${c.subject.block}`);
  else bump(extra, `${c.clip.id} (${c.clip.face}) of ${c.subject.block}`);
  if (game && (c.clip.face === "top" || c.clip.face === "bottom")) {
    const rel = (((game.dir - c.subject.pose.dir) % 4) + 4) % 4;
    const key = `${c.clip.id} in ${c.subject.block}`;
    const m = dirs.get(key) ?? dirs.set(key, new Map()).get(key)!;
    m.set(rel, (m.get(rel) ?? 0) + 1);
  }
}
const unclaimed = new Map<string, number>();
for (const g of truth.clips) if (!claimed.has(g)) bump(unclaimed, g.name);

const top = (m: Map<string, number>, n = 15) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`  clips: ${all.length} ours, ${agree} agree with the game (${((100 * agree) / all.length).toFixed(1)}%)`);
console.log(`  rule check — "ghost blocks are off the grid" would agree on ${agreeOffGrid} (${((100 * agreeOffGrid) / all.length).toFixed(1)}%)`);
for (const [k, v] of Object.entries(byKind)) console.log(`     clips of ${k} blocks: ${v.n}; current rule agrees on ${v.agree}, off-grid rule on ${v.offGrid}`);
console.log(`  MISSING — the game shows it, we hide it: ${total(missing)}`);
for (const [k, n] of top(missing)) console.log(`     ${n} x ${k}`);
console.log(`  EXTRA — we show it, the game does not: ${total(extra)}`);
for (const [k, n] of top(extra)) console.log(`     ${n} x ${k}`);
console.log(`  game clip blocks no block of ours accounts for: ${total(unclaimed)}`);
for (const [k, n] of top(unclaimed, 10)) console.log(`     ${n} x ${k}`);

// Cap direction: a clip whose direction relative to its block is not always 0
// is one the game turns — the table the extractor's shape fit has to reproduce.
const turned = [...dirs].filter(([, m]) => [...m.keys()].some((d) => d !== 0));
console.log(`  top/bottom clips matched: ${dirs.size} kinds, ${turned.length} turned relative to their block`);
for (const [k, m] of turned.slice(0, 40)) console.log(`     ${k}: ${[...m].map(([d, n]) => `${d * 90}deg x${n}`).join(", ")}`);
process.exit(total(missing) + total(extra) ? 1 : 0);
