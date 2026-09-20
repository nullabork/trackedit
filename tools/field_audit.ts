/**
 * Developer check: are we using — and keeping — every field a map's blocks and items carry?
 *
 * `meshdump fieldaudit` lists, by reflection, every property GBX.NET exposes on the blocks,
 * free blocks, items and baked blocks of a map, how often each is set and to what, and which
 * of the 32 flag bits occur. This tool does two things with it, for every map cached under
 * maps/gbx (or the ones named):
 *
 * 1. KEPT ON SAVE. The map goes through the real save path untouched (`meshdump map` ->
 *    editor import/export -> `meshdump build`) and is audited again. Every field of blocks,
 *    free blocks and items must come out with the same counts and values — including the
 *    ones the editor's own dump never mentions (snaps, skins, macroblock references,
 *    authors, decals), which `npm run roundtrip` cannot see. Baked blocks are expected to
 *    be gone: the game rebuilds them.
 * 2. USED FOR DRAWING. Every field that is set anywhere must have a verdict in REVIEW below:
 *    does the editor draw by it, merely keep it, or is it still to do. A field nobody has
 *    judged fails the check, so a new one (a game update, a newer GBX.NET) cannot slip by.
 *
 * usage: npx tsx tools/field_audit.ts [map.Map.Gbx ...] [--verbose]      (npm run fieldaudit)
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

type Verdict = "draws" | "kept" | "todo";
/**
 * What the editor does with each field. "draws": what is shown depends on it and that is
 * verified somewhere (the named check). "kept": no effect on what is shown, or none we
 * model; preserved on save. "todo": it does or may change what the game shows and the
 * editor does not read it yet.
 */
const REVIEW: Record<string, Record<string, [Verdict, string]>> = {
  block: {
    Name: ["draws", "the block"], BlockModel: ["draws", "the block (same as Name)"],
    Coord: ["draws", "grid cell"], Direction: ["draws", "quarter turn"],
    IsFree: ["draws", "free placement"], AbsolutePositionInMap: ["draws", "free position"], YawPitchRoll: ["draws", "free rotation (yaw, roll, pitch order; NOTES 5d)"],
    Flags: ["kept", "the raw bits; the named ones below are what is read"],
    IsGround: ["draws", "air/ground variant (bit 12; variantcheck)"],
    Bit21: ["draws", "lowest bit of the variant index in bits 21-26 (variantcheck; free blocks too, NOTES 5i)"],
    IsGhost: ["kept", "bit 28; no effect on clips (cliptruth: ghost blocks join like any other)"],
    Color: ["draws", "block colour"],
    WaypointSpecialProperty: ["draws", "start/checkpoint/finish lists, linked checkpoints"],
    SubVariant: ["draws", "bits 6-11: the COLUMN of the variant's Mobils table, an alternative build (\"B\" shape, \"v2\" materials); variantcheck, NOTES 5k"],
    Variant: ["draws", "bits 0-5: the ROW of the variant's Mobils table, e.g. a pillar's height piece or its empty row; variantcheck, NOTES 5k"],
    Skin: ["draws", "the surface a pillar takes from the platform above it (Skin.Text \"PlatformIce\\\\\" = that terrain modifier's material swaps; skins.json, variantcheck, NOTES 5l). A skin naming an IMAGE pack (signs, screens) is not drawn yet"],
    IsPillar: ["kept", "bit 14: the block stands in for an auto pillar; drawn as the named block"],
    IsReplacement: ["kept", "bit 16: replaced a pillar; drawn as the named block"],
    LightmapQuality: ["kept", "shadow baking hint"], MacroblockReference: ["kept", "which macroblock placed it"],
    Author: ["kept", "bit 15: block model author"],
    DecalId: ["kept", "unused by Nadeo blocks"], DecalIntensity: ["kept", "constant 1"], DecalVariant: ["kept", "constant -1"],
    TMUnlimiterData: ["kept", "TMUF only"], PhyCharSpecialProperty: ["kept", "unused"], SquareCardEventIds: ["kept", "unused"],
    IsClip: ["kept", "never set in map files (clips are in BakedBlocks)"],
  },
  item: {
    ItemModel: ["draws", "the item"], AbsolutePositionInMap: ["draws", "position"], YawPitchRoll: ["draws", "rotation"], PitchYawRoll: ["draws", "rotation (same data)"],
    PivotPosition: ["draws", "model origin offset (NOTES 5d)"], Color: ["draws", "item colour"],
    WaypointSpecialProperty: ["draws", "waypoint lists"],
    Scale: ["draws", "uniform scale about the anchor (1 on every item of the cached maps, so unverified against a real one)"],
    PackDesc: ["todo", "item skin, now in the dump: on RHEVARA 153 of 159 are LIGHT COLOURS (Skins\\\\Stadium\\\\LightColors\\\\Coral.dds, LightTube\\\\Orange.zip), the rest screen images (game file or URL). Not drawn: the Skins pack is not part of the Openplanet extraction"],
    ForegroundPackDesc: ["todo", "item skin foreground (a screen's .webm): not drawn"],
    AnimPhaseOffset: ["kept", "animation phase of moving items; nothing is animated in the editor"],
    Flags: ["kept", "raw bits; GBX.NET names none"],
    SnappedOnBlock: ["kept", "what the item was snapped to"], SnappedOnItem: ["kept", "what the item was snapped to"], PlacedOnItem: ["kept", "what the item stands on"],
    SnappedOnGroup: ["kept", "snap group"], BlockUnitCoord: ["kept", "the cell the item belongs to"], AnchorTreeId: ["kept", "unused"],
    LightmapQuality: ["kept", "shadow baking hint"], MacroblockReference: ["kept", "which macroblock placed it"],
  },
};

interface Field { set: number; distinct: number; top: Record<string, number> }
interface Section { count: number; flagBits: Record<string, number>; fields: Record<string, Field> }
type Audit = Record<"blocks" | "freeBlocks" | "items" | "bakedBlocks", Section> & { mapName: string };

const verbose = process.argv.includes("--verbose");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const maps = args.length ? args : readdirSync(join(process.cwd(), "maps", "gbx")).filter((f) => f.endsWith(".Map.Gbx")).map((f) => join("maps", "gbx", f));
const work = mkdtempSync(join(tmpdir(), "trackedit-fields-"));
const audit = (map: string, name: string): Audit => {
  const out = join(work, `${name}.json`);
  run("fieldaudit", map, out);
  return JSON.parse(readFileSync(out, "utf-8")) as Audit;
};

let failed = 0;
const seen = new Map<string, { verdict: Verdict | "UNREVIEWED"; why: string; set: number }>();
try {
  for (const map of maps) {
    const before = audit(map, "before");
    const dumpPath = join(work, "in.json"), placements = join(work, "same.json"), saved = join(work, "same.Map.Gbx");
    run("map", map, dumpPath);
    const doc = new MapDocument();
    const imported = importDump(JSON.parse(readFileSync(dumpPath, "utf-8")) as MapDump);
    doc.reset(imported.layers, { name: imported.name, decoration: imported.decoration });
    writeFileSync(placements, JSON.stringify(exportDump(doc, undefined, undefined, true)));
    run("build", map, placements, saved);
    const after = audit(saved, "after");

    const lost: string[] = [];
    for (const sec of ["blocks", "freeBlocks", "items"] as const) {
      if (before[sec].count !== after[sec].count) lost.push(`${sec}: ${before[sec].count} -> ${after[sec].count}`);
      if (JSON.stringify(before[sec].flagBits) !== JSON.stringify(after[sec].flagBits)) lost.push(`${sec}.flag bits: ${JSON.stringify(before[sec].flagBits)} -> ${JSON.stringify(after[sec].flagBits)}`);
      for (const [name, f] of Object.entries(before[sec].fields)) {
        const g = after[sec].fields[name];
        if (!g || g.set !== f.set || g.distinct !== f.distinct || JSON.stringify(g.top) !== JSON.stringify(f.top))
          lost.push(`${sec}.${name}: set ${f.set} -> ${g?.set ?? "gone"}, distinct ${f.distinct} -> ${g?.distinct ?? "gone"}`);
      }
      const kind = sec === "items" ? "item" : "block";
      for (const [name, f] of Object.entries(before[sec].fields)) {
        if (!f.set) continue;
        const r = REVIEW[kind][name];
        const key = `${kind}.${name}`;
        const prev = seen.get(key);
        seen.set(key, { verdict: r?.[0] ?? "UNREVIEWED", why: r?.[1] ?? "no verdict in tools/field_audit.ts", set: (prev?.set ?? 0) + f.set });
      }
    }
    if (lost.length) failed++;
    console.log(`${lost.length ? "FAIL" : "ok  "} ${map}  ${before.blocks.count} blocks, ${before.freeBlocks.count} free, ${before.items.count} items: ` +
      (lost.length ? `${lost.length} fields change on an untouched save` : "every field survives an untouched save") +
      `; baked blocks ${before.bakedBlocks.count} -> ${after.bakedBlocks.count}`);
    for (const l of lost.slice(0, verbose ? 100 : 8)) console.log(`       ${l}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const order: Record<string, number> = { UNREVIEWED: 0, todo: 1, draws: 2, kept: 3 };
const rows = [...seen].sort((a, b) => order[a[1].verdict] - order[b[1].verdict] || b[1].set - a[1].set);
const unreviewed = rows.filter(([, r]) => r.verdict === "UNREVIEWED").length;
console.log(`\nfields set on at least one block or item in these maps: ${rows.length}`);
for (const [key, r] of rows) if (verbose || r.verdict === "UNREVIEWED" || r.verdict === "todo") console.log(`  ${r.verdict.padEnd(10)} ${key.padEnd(34)} set ${String(r.set).padStart(6)}x  ${r.why}`);
const n = (v: string) => rows.filter(([, r]) => r.verdict === v).length;
console.log(`  ${n("draws")} drawn by, ${n("kept")} kept only, ${n("todo")} still to do, ${unreviewed} unreviewed${verbose ? "" : " (--verbose lists all)"}`);
process.exit(failed || unreviewed ? 1 : 0);
