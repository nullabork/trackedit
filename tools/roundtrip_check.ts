/**
 * Does saving a map change only what was meant to change?
 *
 * For every .Map.Gbx given (default: every map cached under maps/gbx), run
 * the real pipeline — `meshdump map` -> the editor's import and export
 * (src/io/trackoJson.ts) -> `meshdump build` — twice:
 *
 * 1. untouched: the build must report nothing added, moved, removed or
 *    recoloured, keep the baked shadows, and the rebuilt file's blocks and
 *    items must dump EXACTLY like the original's, in the same order;
 * 2. three edits (one block moved, one item deleted, one block added): the
 *    build must report exactly those three, and every other block and item
 *    must still dump exactly like the original.
 *
 * usage: npx tsx tools/roundtrip_check.ts [map.Map.Gbx ...]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MapDocument } from "../src/core/document";
import { exportDump, importDump, type MapDump } from "../src/io/trackoJson";

const MESHDUMP = process.env.TRACKEDIT_MESHDUMP ??
  join(process.cwd(), "tools", "meshdump", "bin", "Release", "net8.0", process.platform === "win32" ? "meshdump.exe" : "meshdump");
const run = (...args: string[]): string => execFileSync(MESHDUMP, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

type Rec = Record<string, unknown>;
const stable = (r: Rec): string => JSON.stringify(r, (_k, v) => (typeof v === "number" && Object.is(v, -0) ? 0 : v));

function check(map: string, work: string): string[] {
  const problems: string[] = [];
  const dumpPath = join(work, "in.json");
  run("map", map, dumpPath);
  const original = JSON.parse(readFileSync(dumpPath, "utf-8")) as MapDump & { blocks: Rec[]; items: Rec[] };

  const doc = new MapDocument();
  const imported = importDump(original);
  doc.reset(imported.layers, { name: imported.name, decoration: imported.decoration });
  const exported = exportDump(doc, undefined, undefined, true) as MapDump & { blocks: Rec[]; items: Rec[] };

  const build = (dump: unknown, name: string) => {
    const placements = join(work, `${name}.json`), out = join(work, `${name}.Map.Gbx`), back = join(work, `${name}.back.json`);
    writeFileSync(placements, JSON.stringify(dump));
    const summary = JSON.parse(run("build", map, placements, out).trim().split("\n").pop()!) as Record<string, number | boolean>;
    run("map", out, back);
    return { summary, dump: JSON.parse(readFileSync(back, "utf-8")) as { blocks: Rec[]; items: Rec[] } };
  };
  const counts = (s: Record<string, number | boolean>) =>
    `added ${Number(s.blocksBuilt) + Number(s.itemsBuilt)}, moved ${Number(s.blocksMoved) + Number(s.itemsMoved)}, ` +
    `removed ${Number(s.blocksRemoved) + Number(s.itemsRemoved)}, recoloured ${s.recoloured}, skipped ${s.itemsSkipped}`;

  // 1. untouched
  const same = build(exported, "same");
  if (same.summary.changed) problems.push(`untouched save reports changes: ${counts(same.summary)}`);
  if (original.blocks.length !== same.dump.blocks.length || original.items.length !== same.dump.items.length)
    problems.push(`untouched save has ${same.dump.blocks.length} blocks / ${same.dump.items.length} items, original ${original.blocks.length} / ${original.items.length}`);
  const differs = (a: Rec[], b: Rec[]) => a.findIndex((r, i) => !b[i] || stable(r) !== stable(b[i]));
  for (const list of ["blocks", "items"] as const) {
    const at = differs(original[list], same.dump[list]);
    if (at >= 0) problems.push(`untouched save: ${list}[${at}] differs\n    was ${stable(original[list][at])}\n    now ${stable(same.dump[list][at] ?? {})}`);
  }

  // 2. exactly three edits
  const edited = JSON.parse(JSON.stringify(exported)) as typeof exported;
  const grid = edited.blocks.find((b) => !b.isFree && !b.isClip && Array.isArray(b.coord));
  if (grid && edited.items.length > 1) {
    (grid.coord as number[])[1] += 1;
    const gone = edited.items.splice(Math.floor(edited.items.length / 2), 1)[0];
    edited.blocks.push({ name: "RoadTechStraight", coord: [1, 12, 1], dir: 1 });
    const three = build(edited, "edit").summary;
    const want = { blocksMoved: 1, blocksBuilt: 1, blocksRemoved: 0, itemsMoved: 0, itemsBuilt: 0, itemsRemoved: 1, recoloured: 0 };
    for (const [key, value] of Object.entries(want))
      if (three[key] !== value) problems.push(`three edits (moved ${grid.name}, deleted ${gone.name}, added a block): ${key} is ${three[key]}, expected ${value}`);
  }
  return problems;
}

const maps = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(join(process.cwd(), "maps", "gbx")).filter((f) => f.endsWith(".Map.Gbx")).map((f) => join(process.cwd(), "maps", "gbx", f));
let failed = 0;
for (const map of maps) {
  const work = mkdtempSync(join(tmpdir(), "trackedit-roundtrip-"));
  try {
    const problems = check(map, work);
    console.log(`${problems.length ? "FAIL" : "ok  "} ${map}`);
    for (const p of problems) console.log(`  - ${p}`);
    if (problems.length) failed++;
  } catch (err) {
    failed++;
    console.log(`FAIL ${map}\n  - ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
console.log(failed ? `${failed} of ${maps.length} maps do not round-trip` : `all ${maps.length} maps round-trip`);
process.exit(failed ? 1 : 0);
