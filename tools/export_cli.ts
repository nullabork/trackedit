/**
 * CLI harness for the editor's IO layer: parsed-map JSON in, gbxbuild
 * placements JSON out, through the exact same import/export code the browser
 * runs. Useful for pipeline tests without a browser.
 *
 * usage: npx tsx tools/export_cli.ts <in.json> <out.placements.json>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { MapDocument } from "../src/core/document";
import { importDump, exportDump } from "../src/io/trackoJson";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: tsx tools/export_cli.ts <in.json> <out.placements.json>");
  process.exit(1);
}

const dump = JSON.parse(readFileSync(inPath, "utf-8"));
const doc = new MapDocument();
const res = importDump(dump);
doc.reset(res.layers, { name: res.name, decoration: res.decoration });
const out = exportDump(doc);
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(
  `imported ${res.stats.gridBlocks}+${res.stats.freeBlocks} blocks, ${res.stats.items} items -> ` +
  `exported ${out.blocks?.length} blocks, ${out.items?.length} items -> ${outPath}`,
);
