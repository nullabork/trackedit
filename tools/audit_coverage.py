"""Coverage audit: which catalog blocks/items lack geometry or textures.

Cross-references:
  public/catalog.json          - everything the palette offers
  public/meshes/index.json     - what meshdump exported (geometry)
  public/meshes/materials.json - which materials have textures
  public/meshes/**/*.obj       - which materials each mesh actually uses

usage: python tools/audit_coverage.py [--verbose]
"""

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MESHES = ROOT / "public" / "meshes"
VERBOSE = "--verbose" in sys.argv

catalog = json.loads((ROOT / "public" / "catalog.json").read_text(encoding="utf-8"))
index = json.loads((MESHES / "index.json").read_text(encoding="utf-8"))
materials = json.loads((MESHES / "materials.json").read_text(encoding="utf-8"))

idx_blocks = index.get("blocks", {})
idx_items = index.get("items", {})

# --- geometry coverage ---
missing_blocks = [b["name"] for b in catalog["blocks"] if b["name"] not in idx_blocks]
missing_items = [i["name"] for i in catalog["items"]
                 if i["name"] not in idx_items and i["name"] not in idx_blocks]

print(f"BLOCKS: {len(catalog['blocks'])} in catalog, "
      f"{len(catalog['blocks']) - len(missing_blocks)} with geometry, "
      f"{len(missing_blocks)} missing")
print(f"ITEMS:  {len(catalog['items'])} in catalog, "
      f"{len(catalog['items']) - len(missing_items)} with geometry, "
      f"{len(missing_items)} missing")

def prefix_summary(names, n=15):
    c = Counter()
    for name in names:
        # group by leading alpha run for a readable summary
        p = ""
        for ch in name:
            if ch.isupper() and p and p[-1].islower():
                break
            p += ch
        c[p] += 1
    return c.most_common(n)

if missing_blocks:
    print("\nmissing block groups (by prefix):")
    for p, n in prefix_summary(missing_blocks):
        print(f"  {n:4d}  {p}…")
    if VERBOSE:
        for name in sorted(missing_blocks):
            print("   -", name)

if missing_items:
    print("\nmissing item groups (by prefix):")
    for p, n in prefix_summary(missing_items):
        print(f"  {n:4d}  {p}…")
    if VERBOSE:
        for name in sorted(missing_items):
            print("   -", name)

# --- texture coverage: which usemtl names appear in OBJs ---
used = Counter()
for obj in MESHES.rglob("*.obj"):
    try:
        for line in obj.open(encoding="utf-8", errors="ignore"):
            if line.startswith("usemtl "):
                used[line[7:].strip()] += 1
    except OSError:
        pass

no_texture = {m: n for m, n in used.items()
              if materials.get(m, {}).get("texture") in (None, "")
              and not materials.get(m, {}).get("color")}
unknown = {m: n for m, n in used.items() if m not in materials}

print(f"\nMATERIALS: {len(used)} distinct usemtl names across OBJs, "
      f"{len(no_texture)} without a texture, {len(unknown)} not in materials.json")
if no_texture:
    print("\nmaterials WITHOUT texture (usage count):")
    for m, n in sorted(no_texture.items(), key=lambda kv: -kv[1]):
        print(f"  {n:5d}  {m}")
if unknown:
    print("\nmaterials NOT IN materials.json (usage count):")
    for m, n in sorted(unknown.items(), key=lambda kv: -kv[1])[:20]:
        print(f"  {n:5d}  {m}")
