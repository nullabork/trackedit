/**
 * Developer check: trackedit's clip pieces against the game's own.
 *
 * Around every block the game generates clip blocks (undersides, top plates,
 * side walls, end caps) and BAKES them into the map file (`meshdump baked`:
 * name, cell, direction). That is ground truth for two things worked out on
 * our side: which clip pieces show given a block's neighbours
 * (src/render/clipAdjacency.ts) and which way a top/bottom piece faces inside
 * its block (the extractor's shape fit). Compared clip by clip:
 *
 * - shown by us, absent in the game  -> we draw a surface the game does not;
 * - present in the game, hidden by us -> a surface or shell is missing;
 * - per clip name, the game's direction relative to its block -> the ground
 *   truth for cap orientation, to check the extractor's turns against.
 *
 * Where the game puts a clip block (the unit's own cell or the cell it faces)
 * is measured rather than assumed: both are tried and the better one is used.
 * Maps saved by trackedit have no baked blocks (the game rebuilds them): use
 * files from the game or TMX.
 *
 * usage: npx tsx tools/clip_truth.ts [map.Map.Gbx ...] [--explain]   (npm run cliptruth)
 *        no map = every map cached under maps/gbx, with totals; --explain tabulates what the
 *        game did per situation (what the clip faces), which is how the rule was derived.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MapDocument } from "../src/core/document";
import { placementVariant } from "../src/core/layer";
import type { GridCoord } from "../src/core/math";
import { baseTypeOf } from "../src/core/mapbase";
import { importDump, type MapDump } from "../src/io/trackoJson";
import { FACE_NORMAL, cellKey, clipHiddenBy, clipPartName, faceToward, hiddenClipParts, occupiedCells, rotateByDir, unitCell, withClipDefs } from "../src/render/clipAdjacency";
import type { BlockClipInfo, ClipDefs, ClipSubject, UnitClip } from "../src/render/clipAdjacency";
import { ClipFaceIndex, freeClipFaces, gridClipFaces, hiddenClipFaces } from "../src/render/clipFaces";
import type { ClipFace } from "../src/render/clipFaces";

const MESHDUMP = process.env.TRACKEDIT_MESHDUMP ??
  join(process.cwd(), "tools", "meshdump", "bin", "Release", "net8.0", process.platform === "win32" ? "meshdump.exe" : "meshdump");

interface TruthBlock { name: string; coord: GridCoord; dir: number; ghost: boolean }
interface Truth { mapName: string; clips: TruthBlock[] }

type Entry = { size?: [number, number, number]; units?: Record<string, [number, number, number][] | null>; clips?: Record<string, BlockClipInfo["clips"] | null> };
const index = (JSON.parse(readFileSync(join(process.cwd(), "public", "meshes", "index.json"), "utf-8")) as { blocks: Record<string, Entry> }).blocks;

const clipDefs = JSON.parse(readFileSync(join(process.cwd(), "public", "meshes", "clipdefs.json"), "utf-8")) as ClipDefs;

/** Same fallbacks, and the same definitions, as MeshProvider.blockClips. */
function clipInfo(block: string, variant: string): BlockClipInfo | undefined {
  const entry = index[block];
  if (!entry) return undefined;
  const base = variant.startsWith("ground") ? "ground" : "air", other = base === "air" ? "ground" : "air";
  return {
    size: entry.size ?? [1, 1, 1],
    units: entry.units?.[variant] ?? entry.units?.[base] ?? entry.units?.[other] ?? [],
    clips: withClipDefs(entry.clips?.[variant] ?? entry.clips?.[base] ?? entry.clips?.[other] ?? [], clipDefs),
  };
}

const mapArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (mapArgs.length !== 1) {
  // No map, or several: every one (default: all cached under maps/gbx) in its own run, then the totals.
  const maps = mapArgs.length ? mapArgs : readdirSync(join(process.cwd(), "maps", "gbx")).filter((f) => f.endsWith(".Map.Gbx")).map((f) => join("maps", "gbx", f));
  let wrong = 0, total = 0;
  for (const map of maps) {
    const run = spawnSync(process.execPath, [...process.execArgv, process.argv[1], map, "--brief"], { encoding: "utf-8" });
    const m = /clips: (\d+) ours, (\d+) agree/.exec(run.stdout ?? "");
    if (m) { total += Number(m[1]); wrong += Number(m[1]) - Number(m[2]); }
    console.log([map, (run.stdout ?? "").trimEnd(), (run.stderr ?? "").trimEnd()].filter(Boolean).join("\n"));
  }
  console.log(`TOTAL: ${total} clips on ${maps.length} maps, ${wrong} differ from the game (${total ? ((100 * (total - wrong)) / total).toFixed(2) : "-"}% agree)`);
  process.exit(wrong ? 1 : 0);
}
const mapPath = mapArgs[0];
const brief = process.argv.includes("--brief");

const work = mkdtempSync(join(tmpdir(), "trackedit-truth-"));
let doc: MapDocument;
let truth: Truth;
const bakedFree = new Map<string, number>();
try {
  const dumpPath = join(work, "dump.json");
  execFileSync(MESHDUMP, ["map", mapPath, dumpPath], { stdio: "ignore" });
  const bakedPath = join(work, "baked.json");
  execFileSync(MESHDUMP, ["baked", mapPath, bakedPath], { stdio: "ignore" });
  const baked = JSON.parse(readFileSync(bakedPath, "utf-8")) as { mapName: string; baked: Array<{ name: string; coord: GridCoord; dir: number; isGhost: boolean; isFree: boolean }> };
  // Clips of free blocks are baked without a cell: compared by name and count further down.
  truth = { mapName: baked.mapName, clips: baked.baked.filter((b) => !b.isFree).map((b) => ({ name: b.name, coord: b.coord, dir: b.dir, ghost: b.isGhost })) };
  for (const b of baked.baked) if (b.isFree) bakedFree.set(b.name, (bakedFree.get(b.name) ?? 0) + 1);
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

const yShift = 0;
console.log(`${truth.mapName}: the game baked ${truth.clips.length} blocks into the file; ours ${subjects.length} blocks`);
if (!truth.clips.length) {
  console.error("  no baked blocks — the map was saved by a tool that drops them (trackedit's own saves do); use the game's or TMX's file");
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

interface OurClip { subject: Subject; clip: UnitClip; own: GridCoord; faced: GridCoord; hidden: boolean }
const all: OurClip[] = [];
for (const s of subjects) {
  const gone = hiddenClipParts(s, (cell) => (cells.get(cellKey(cell)) ?? []).filter((o) => o !== s));
  for (const clip of s.info.clips) {
    const own = unitCell(s.pose, s.info.size, clip.u);
    const n = rotateByDir(FACE_NORMAL[clip.face], s.pose.dir);
    all.push({ subject: s, clip, own, faced: [own[0] + n[0], own[1] + n[1], own[2] + n[2]], hidden: gone.has(clipPartName(clip)) });
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

/**
 * The situation a clip is in, as a short label: who places it (Ghost/Normal block),
 * cap or side, and the strongest thing in the cell it faces — a neighbour whose clip
 * joins it (join), one that merely stands there (occ), or nothing (free); for caps also
 * whether another block fills the cap's own cell (in). `--explain` tabulates what the
 * game did per situation, which is how the rule in clipAdjacency.ts gets derived.
 */
function situation(c: OurClip): string {
  const s = c.subject;
  const n = rotateByDir(FACE_NORMAL[c.clip.face], s.pose.dir);
  const cap = c.clip.face === "top" || c.clip.face === "bottom";
  const flagsOf = (id: string) => `${clipDefs[id]?.full ? "F" : "-"}${clipDefs[id]?.deletable ? "D" : "-"}`;
  const found = new Set<string>();
  for (const o of cells.get(cellKey(c.faced)) ?? []) {
    if (o === s) { found.add("self"); continue; }
    const face = faceToward([-n[0], -n[1], -n[2]], o.pose.dir);
    const unit = (o.info.units.length ? o.info.units : [[0, 0, 0] as [number, number, number]]).find((u) => cellKey(unitCell(o.pose, o.info.size, u)) === cellKey(c.faced));
    const facing = face && unit ? o.info.clips.filter((d) => d.face === face && d.u.join() === unit.join()) : [];
    if (!facing.length) { found.add("body"); continue; }
    for (const d of facing) found.add(`${clipHiddenBy(c.clip, d) ? "hides" : "clip"}(${flagsOf(d.id)})`);
  }
  const inside = cap && (cells.get(cellKey(c.own)) ?? []).some((o) => o !== s);
  return `${cap ? "cap " : "side"} ${flagsOf(c.clip.id)} vs ${[...found].sort().join("+") || "free"}${inside ? " in" : ""}`;
}
/** The clip ids on the faces looking back at a clip. */
function facingIds(c: OurClip): string {
  const s = c.subject, n = rotateByDir(FACE_NORMAL[c.clip.face], s.pose.dir), ids = new Set<string>();
  for (const o of cells.get(cellKey(c.faced)) ?? []) {
    if (o === s) continue;
    const face = faceToward([-n[0], -n[1], -n[2]], o.pose.dir);
    const unit = (o.info.units.length ? o.info.units : [[0, 0, 0] as [number, number, number]]).find((u) => cellKey(unitCell(o.pose, o.info.size, u)) === cellKey(c.faced));
    for (const d of face && unit ? o.info.clips : []) if (d.face === face && d.u.join() === unit!.join()) ids.add(d.id);
  }
  return [...ids].sort().join(" + ") || "(no clip)";
}
const wrongPairs = new Map<string, number>();
const situations = new Map<string, { shown: number; hidden: number; wrong: number }>();

/** The compass direction (0..3, as block directions) a side clip's face looks. */
function lookDir(c: OurClip): number {
  const n = rotateByDir(FACE_NORMAL[c.clip.face], c.subject.pose.dir);
  return [0, 1, 2, 3].find((k) => rotateByDir(FACE_NORMAL.north, k as 0 | 1 | 2 | 3).every((v, i) => v === n[i]))!;
}

let agree = 0;
const extra = new Map<string, number>(), missing = new Map<string, number>(), dirs = new Map<string, Map<number, number>>();
const claimed = new Set<TruthBlock>();
const sideDirs = new Map<number, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
for (const c of all) {
  const list = gameClips.get(`${c.clip.id}@${cellKey(where === "own" ? c.own : c.faced)}`) ?? [];
  // A side clip sits in the cell it faces and points back at its block (measured: 98%+,
  // the rest being clips of another neighbour in the same cell) — so match on direction too.
  const cap = c.clip.face === "top" || c.clip.face === "bottom";
  const back = cap ? -1 : (lookDir(c) + 2) % 4;
  const game = list.find((g) => !claimed.has(g) && (cap || g.dir === back));
  if (game) claimed.add(game);
  if (process.argv.includes("--explain")) {
    const k = situation(c);
    const t = situations.get(k) ?? situations.set(k, { shown: 0, hidden: 0, wrong: 0 }).get(k)!;
    if (game) t.shown++; else t.hidden++;
    if (!!game === c.hidden) {
      t.wrong++;
      const pair = `${game ? "game shows" : "game hides"} ${c.clip.id} facing ${facingIds(c)}`;
      wrongPairs.set(pair, (wrongPairs.get(pair) ?? 0) + 1);
    }
  }
  if (!!game === !c.hidden) agree++;
  else if (game) bump(missing, `${c.clip.id} (${c.clip.face}) of ${c.subject.block}`);
  else bump(extra, `${c.clip.id} (${c.clip.face}) of ${c.subject.block}`);
  if (game && c.clip.face !== "top" && c.clip.face !== "bottom") {
    // Which way does the game turn a side clip, relative to the way its face looks?
    const rel = (((game.dir - lookDir(c)) % 4) + 4) % 4;
    sideDirs.set(rel, (sideDirs.get(rel) ?? 0) + 1);
  }
  if (game && (c.clip.face === "top" || c.clip.face === "bottom")) {
    const rel = (((game.dir - c.subject.pose.dir) % 4) + 4) % 4;
    const key = `${c.clip.id} in ${c.subject.block}`;
    const m = dirs.get(key) ?? dirs.set(key, new Map()).get(key)!;
    m.set(rel, (m.get(rel) ?? 0) + 1);
  }
}
// --- free blocks: no cell to compare by, so per clip name, how many the game baked vs how many we show ---
const freeFaces = new Map<string, ClipFace[]>(), gridFaces: ClipFace[] = [];
for (const layer of doc.layers) for (const p of layer.placements.values()) {
  if (p.kind === "free" && !p.isItem) {
    const info = clipInfo(p.block, placementVariant(p, stadium));
    if (info?.clips.length) freeFaces.set(p.id, freeClipFaces(p.id, p.pos, p.rot, info));
  } else if (p.kind === "block") {
    const info = clipInfo(p.block, placementVariant(p, stadium));
    if (info) gridFaces.push(...gridClipFaces(p.id, { coord: p.coord, dir: p.dir }, info));
  }
}
let freeWrong = 0, freeTotal = 0;
if (freeFaces.size || bakedFree.size) {
  const score = (withGrid: boolean) => {
    const index = new ClipFaceIndex();
    for (const faces of freeFaces.values()) for (const f of faces) index.add(f);
    if (withGrid) for (const f of gridFaces) index.add(f);
    const shown = new Map<string, number>();
    for (const faces of freeFaces.values()) {
      const gone = hiddenClipFaces(faces, index);
      for (const f of faces) if (!gone.has(clipPartName(f.clip))) shown.set(f.clip.id, (shown.get(f.clip.id) ?? 0) + 1);
    }
    let diff = 0;
    const rows: string[] = [];
    for (const name of new Set([...shown.keys(), ...bakedFree.keys()])) {
      const ours = shown.get(name) ?? 0, game = bakedFree.get(name) ?? 0;
      diff += Math.abs(ours - game);
      if (ours !== game) rows.push(`${name}: game ${game}, ours ${ours}`);
    }
    return { diff, rows };
  };
  freeTotal = [...freeFaces.values()].reduce((n, f) => n + f.length, 0);
  const alone = score(false), mixed = score(true);
  freeWrong = alone.diff;
  const gameTotal = [...bakedFree.values()].reduce((a, b) => a + b, 0);
  console.log(`  free blocks: ${freeFaces.size} with clips, ${freeTotal} clip pieces; the game baked ${gameTotal}`);
  console.log(`     off by ${alone.diff} when free clips join each other only (the editor's rule), by ${mixed.diff} if they joined grid blocks too, by ${Math.abs(freeTotal - gameTotal)} if nothing joined`);
  for (const r of alone.rows.sort().slice(0, brief ? 4 : 20)) console.log(`       ${r}`);
}

const unclaimed = new Map<string, number>();
for (const g of truth.clips) if (!claimed.has(g)) bump(unclaimed, g.name);

const top = (m: Map<string, number>, n = brief ? 4 : 15) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`  clips: ${all.length} ours, ${agree} agree with the game (${((100 * agree) / all.length).toFixed(1)}%)`);
if (situations.size) {
  console.log("  situation (placer, kind, what it faces)            game shows   game hides   we get wrong");
  for (const [k, t] of [...situations].sort((a, b) => b[1].wrong - a[1].wrong)) console.log(`     ${k.padEnd(48)} ${String(t.shown).padStart(8)} ${String(t.hidden).padStart(12)} ${String(t.wrong).padStart(12)}`);
}
if (wrongPairs.size) {
  console.log("  pairs we get wrong:");
  for (const [k, n] of top(wrongPairs, 25)) console.log(`     ${String(n).padStart(5)}  ${k}`);
}
console.log(`  MISSING — the game shows it, we hide it: ${total(missing)}`);
for (const [k, n] of top(missing)) console.log(`     ${n} x ${k}`);
console.log(`  EXTRA — we show it, the game does not: ${total(extra)}`);
for (const [k, n] of top(extra)) console.log(`     ${n} x ${k}`);
console.log(`  game clip blocks no block of ours accounts for: ${total(unclaimed)}`);
for (const [k, n] of top(unclaimed, 10)) console.log(`     ${n} x ${k}`);

console.log(`  side clips: game direction minus the direction the face looks: ${[...sideDirs].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d * 90}deg x${n}`).join(", ")}`);
if (brief) process.exit(total(missing) + total(extra) ? 1 : 0);
// Cap direction: a clip whose direction relative to its block is not always 0
// is one the game turns — the table the extractor's shape fit has to reproduce.
const turned = [...dirs].filter(([, m]) => [...m.keys()].some((d) => d !== 0));
console.log(`  top/bottom clips matched: ${dirs.size} kinds, ${turned.length} turned relative to their block`);
for (const [k, m] of turned.slice(0, 40)) console.log(`     ${k}: ${[...m].map(([d, n]) => `${d * 90}deg x${n}`).join(", ")}`);
process.exit(total(missing) + total(extra) ? 1 : 0);
