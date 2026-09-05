"""Build the editor's block/item catalog from parsed maps.

Reads block/item usage out of an external corpus of parsed Map.Gbx JSONs
(e.g. the companion tracko project's data/parsed, read-only) and writes
public/catalog.json. Usage counts give the palette a sensible default
ordering until real BlockInfo metadata is extracted from the game paks.

usage: python tools/build_catalog.py <parsed_dir>
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if len(sys.argv) < 2:
    sys.exit("usage: python tools/build_catalog.py <parsed-maps-dir>")
PARSED = Path(sys.argv[1])
OUT = ROOT / "public" / "catalog.json"
INVENTORY_DIR = Path.home() / "OpenplanetNext/Extract/GameData/Stadium/GameCtnBlockInfo"


def load_inventory(filename: str) -> set:
    """Names the current game actually offers in its editor. The dumped JSON
    has trailing commas, so tolerate them. Anything not in here is legacy
    TitlePack content the game refuses to load."""
    path = INVENTORY_DIR / filename
    if not path.exists():
        return set()
    text = re.sub(r",\s*([}\]])", r"\1", path.read_text(encoding="utf-8"))
    names: set = set()

    def walk(node):
        if isinstance(node, dict):
            if "Name" in node and not node.get("IsFolder"):
                names.add(node["Name"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(json.loads(text))
    return names

block_counts: Counter = Counter()
item_counts: Counter = Counter()
item_authors: dict = {}

files = sorted(PARSED.glob("*.json"))
for f in files:
    try:
        m = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        continue
    for b in m.get("blocks") or []:
        n = b.get("name")
        if n:
            block_counts[n] += 1
    for it in m.get("items") or []:
        n = it.get("name")
        if n:
            item_counts[n] += 1
            a = it.get("itemAuthor")
            if a and n not in item_authors:
                item_authors[n] = a

CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")

PREFIX_CATEGORIES = [
    ("RoadTech", "Road Tech"), ("RoadDirt", "Road Dirt"), ("RoadBump", "Road Bump"),
    ("RoadIce", "Road Ice"), ("RoadWater", "Road Water"), ("Road", "Road"),
    ("PlatformTech", "Platform Tech"), ("PlatformDirt", "Platform Dirt"),
    ("PlatformIce", "Platform Ice"), ("PlatformPlastic", "Platform Plastic"),
    ("PlatformGrass", "Platform Grass"), ("PlatformWater", "Platform Water"),
    ("Platform", "Platform"),
    ("TrackWall", "Track Wall"), ("Canopy", "Canopy"), ("Deco", "Decoration"),
    ("Structure", "Structure"), ("Stage", "Stage"), ("Gate", "Gate"),
    ("OpenTech", "Open Tech"), ("OpenDirt", "Open Dirt"), ("Open", "Open"),
    ("SnowRoad", "Snow Road"), ("Snow", "Snow"),
    ("Water", "Water"), ("Grass", "Grass"), ("Ice", "Ice"),
    ("Tunnel", "Tunnel"), ("Pillar", "Pillar"),
]


def category(name: str) -> str:
    for prefix, cat in PREFIX_CATEGORIES:
        if name.startswith(prefix):
            return cat
    return "Other"


# Custom embedded blocks carry file-path names ("folder\Thing.Block.Gbx_...");
# official block identifiers never do.
def is_official(n: str) -> bool:
    return "\\" not in n and ".gbx" not in n.lower()


# In the inventory AND used in old maps, yet the game still refuses them
# ("Missing Items" on load) — confirmed by loading a probe map in-game.
DENYLIST = {"Cactus", "CarSport"}


block_inv = load_inventory("BlockInfoInventory.gbx.json")
item_inv = load_inventory("ItemInventory.gbx.json")

# The inventory also contains phantom entries the game refuses to load in a
# map (OpenDirtHills*, GateExpandableCheckpoint...). A backfilled name earns
# a palette slot only if we actually have its geometry.
try:
    _index = json.loads((ROOT / "public" / "meshes" / "index.json").read_text(encoding="utf-8"))
    geom_blocks = set(_index.get("blocks", {}))
    geom_items = set(_index.get("items", {}))
except Exception:
    geom_blocks = geom_items = set()

blocks = [
    {"name": n, "label": CAMEL.sub(" ", n), "category": category(n), "uses": c}
    for n, c in block_counts.most_common()
    if is_official(n) and (not block_inv or n in block_inv)
]
# Inventory blocks the corpus never used still belong in the palette.
seen = {b["name"] for b in blocks}
blocks += [
    {"name": n, "label": CAMEL.sub(" ", n), "category": category(n), "uses": 0}
    for n in sorted(block_inv - seen)
    if n in geom_blocks
]
# Custom (embedded) items vastly outnumber official ones; keep the palette to
# the game's own item inventory (all Nadeo).
items = [
    {"name": n, "label": CAMEL.sub(" ", n), "author": item_authors.get(n, "Nadeo"), "uses": c}
    for n, c in item_counts.most_common()
    if n not in DENYLIST
    and ((n in item_inv) if item_inv else (item_authors.get(n) == "Nadeo"))
]
seen = {i["name"] for i in items}
items += [
    {"name": n, "label": CAMEL.sub(" ", n), "author": "Nadeo", "uses": 0}
    for n in sorted(item_inv - seen)
    if n in geom_items or n in geom_blocks
]

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({
    "source": f"{len(files)} parsed maps",
    "blocks": blocks,
    "items": items,
}, indent=1), encoding="utf-8")

print(f"maps scanned: {len(files)}")
print(f"unique blocks: {len(blocks)}  (total placements {sum(block_counts.values())})")
print(f"unique items:  {len(items)}")
print(f"wrote {OUT}")
