/**
 * Developer check: which clip pieces (caps, side walls) does the editor show
 * where another block sits right against them?
 *
 * Clips are the game's "free clips" — pieces a block shows on a free face.
 * The editor hides a clip when the neighbour carries one that joins it, and a
 * top/bottom cap also when another block swallows it, i.e. fills the cap's
 * own cell and the one it faces (src/render/clipAdjacency.ts). This runs
 * every cached map (or the ones named) through the editor's own import and
 * adjacency code and reports:
 *
 * - caps shown although a block swallows them — must be 0 (a dark plate
 *   poking through the snow hill that shares its cells);
 * - caps and side clips shown against a merely occupied cell — not wrong by
 *   themselves (an arch keeps its underside over a platform below; a wall
 *   stands beside an unrelated block), listed by clip -> neighbour so the
 *   biggest groups can be looked at in the editor.
 *
 * usage: npx tsx tools/clip_check.ts [map.Map.Gbx ...]     (npm run clipcheck)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MapDocument } from "../src/core/document";
import { placementVariant } from "../src/core/layer";
import type { GridCoord } from "../src/core/math";
import { baseTypeOf } from "../src/core/mapbase";
import { importDump, type MapDump } from "../src/io/trackoJson";
import { FACE_NORMAL, cellKey, clipPartName, hiddenClipParts, occupiedCells, rotateByDir, unitCell } from "../src/render/clipAdjacency";
import type { BlockClipInfo, ClipSubject } from "../src/render/clipAdjacency";

const MESHDUMP = process.env.TRACKEDIT_MESHDUMP ??
  join(process.cwd(), "tools", "meshdump", "bin", "Release", "net8.0", process.platform === "win32" ? "meshdump.exe" : "meshdump");
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

const maps = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(join(process.cwd(), "maps", "gbx")).filter((f) => f.endsWith(".Map.Gbx")).map((f) => join(process.cwd(), "maps", "gbx", f));
const work = mkdtempSync(join(tmpdir(), "trackedit-clips-"));
let failed = 0;
try {
  for (const map of maps) {
    const dumpPath = join(work, "dump.json");
    execFileSync(MESHDUMP, ["map", map, dumpPath], { stdio: "ignore" });
    const doc = new MapDocument();
    const imported = importDump(JSON.parse(readFileSync(dumpPath, "utf-8")) as MapDump);
    doc.reset(imported.layers, { name: imported.name, decoration: imported.decoration });
    const stadium = baseTypeOf(doc.decorationBase) === "stadium";

    const subjects: Array<ClipSubject & { block: string }> = [];
    for (const layer of doc.layers) for (const p of layer.placements.values()) {
      if (p.kind !== "block") continue;
      const info = clipInfo(p.block, placementVariant(p, stadium));
      if (info) subjects.push({ pose: { coord: p.coord, dir: p.dir }, info, block: p.block });
    }
    const cells = new Map<string, Array<ClipSubject & { block: string }>>();
    for (const s of subjects) for (const c of occupiedCells(s)) {
      const k = cellKey(c);
      (cells.get(k) ?? cells.set(k, []).get(k)!).push(s);
    }

    let clips = 0, hidden = 0, swallowed = 0, capsAgainstBlocks = 0, sidesAgainstBlocks = 0;
    const sides = new Map<string, number>();
    for (const s of subjects) {
      const gone = hiddenClipParts(s, (cell) => (cells.get(cellKey(cell)) ?? []).filter((o) => o !== s));
      for (const clip of s.info.clips) {
        clips++;
        if (gone.has(clipPartName(clip))) { hidden++; continue; }
        const cell = unitCell(s.pose, s.info.size, clip.u);
        const n = rotateByDir(FACE_NORMAL[clip.face], s.pose.dir);
        const target: GridCoord = [cell[0] + n[0], cell[1] + n[1], cell[2] + n[2]];
        const neighbours = (cells.get(cellKey(target)) ?? []).filter((o) => o !== s);
        if (!neighbours.length) continue;
        const cap = clip.face === "top" || clip.face === "bottom";
        if (cap && neighbours.some((o) => occupiedCells(o).some((c) => cellKey(c) === cellKey(cell)))) swallowed++;
        if (cap) capsAgainstBlocks++;
        else sidesAgainstBlocks++;
        const key = `${cap ? "cap " : "side"} ${clip.id} | ${neighbours[0].block}`;
        sides.set(key, (sides.get(key) ?? 0) + 1);
      }
    }
    if (swallowed) failed++;
    console.log(`${swallowed ? "FAIL" : "ok  "} ${map}\n     ${subjects.length} blocks, ${clips} clips: ${hidden} hidden, ${clips - hidden} shown`);
    console.log(`     caps shown although another block swallows them: ${swallowed}`);
    console.log(`     shown against a merely occupied cell: ${capsAgainstBlocks} caps, ${sidesAgainstBlocks} side clips`);
    for (const [what, n] of [...sides].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`       ${n} x ${what}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `${failed} of ${maps.length} maps show caps inside other blocks` : `all ${maps.length} maps: no cap shown inside another block`);
process.exit(failed ? 1 : 0);
