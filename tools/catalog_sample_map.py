"""Build a validation map: the N most-used blocks of every catalog category,
laid out on a grid (one row per category), saved through the dev server and
opened in the editor.

    python tools/catalog_sample_map.py                 # 8 per category
    python tools/catalog_sample_map.py --per 5 --id map_catalog_sample --open
    python tools/catalog_sample_map.py --only "Road Tech" --per 20

Then `python tools/block_sheets.py --map <id>` captures every placement.
Only blocks with an exported mesh (public/meshes/index.json) are used; each
block gets its footprint plus a two-cell gap, so multi-cell pieces don't
overlap. Blocks are placed on the ground (y=0) so ground variants — the ones
with terrain skirts and structure clips — are what gets reviewed.
"""
import argparse
import json
import random
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--per", type=int, default=8, help="blocks per category")
    ap.add_argument("--id", default="map_catalog_sample")
    ap.add_argument("--name", default="Catalog sample")
    ap.add_argument("--only", help="substring filter on category")
    ap.add_argument("--random", action="store_true", help="random picks instead of most-used")
    ap.add_argument("--spread", action="store_true",
                    help="evenly spaced picks through the category (sorted by name) instead of most-used")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--base", default="http://localhost:5199")
    ap.add_argument("--open", action="store_true", help="open it in the editor tab afterwards")
    args = ap.parse_args()

    catalog = json.loads((ROOT / "public/catalog.json").read_text())["blocks"]
    index = json.loads((ROOT / "public/meshes/index.json").read_text())["blocks"]
    by_cat = {}
    for b in catalog:
        if b["name"] in index:
            by_cat.setdefault(b["category"], []).append(b)

    rng = random.Random(args.seed)
    placements = []
    n = 0
    z = 1
    max_x = 0
    gap = 2
    for cat in sorted(by_cat):
        if args.only and args.only.lower() not in cat.lower():
            continue
        picks = list(by_cat[cat])
        if args.random:
            rng.shuffle(picks)
            picks = picks[: args.per]
        elif args.spread:
            # Every k-th block by name: covers the whole family (curves,
            # slopes, ends, specials) rather than the handful everyone uses.
            picks.sort(key=lambda b: b["name"])
            k = max(1, len(picks) // args.per)
            picks = picks[::k][: args.per]
        else:
            picks.sort(key=lambda b: -b["uses"])
            picks = picks[: args.per]
        x = 1
        row_depth = 1
        for b in picks:
            size = index[b["name"]].get("size") or [1, 1, 1]
            n += 1
            placements.append({
                "id": f"p_cs_{n:04d}",
                "kind": "block",
                "block": b["name"],
                "coord": [x, 0, z],
                "dir": 0,
                "meta": {"category": cat},
            })
            x += size[0] + gap
            row_depth = max(row_depth, size[2])
        max_x = max(max_x, x)
        z += row_depth + gap + 1
    size = [max(48, max_x + 2), 40, max(48, z + 2)]

    rec = {
        "id": args.id,
        "name": args.name,
        "updatedAt": int(time.time() * 1000),
        "placementCount": len(placements),
        "globalClampToBase": False,
        "modUrl": None,
        "activeMod": None,
        "colorPalette": "Classic",
        "decorationBase": "48x48Screen155",
        "mood": "Day",
        "size": size,
        "layers": [{
            "name": "Catalog",
            "visible": True,
            "locked": False,
            "clampToBase": False,
            "settings": {"gridStep": [32, 8, 32], "lodDistance": 4000},
            "transform": {"translate": [0, 0, 0], "rotDeg": [0, 0, 0]},
            "placements": placements,
        }],
    }
    req = urllib.request.Request(
        f"{args.base}/api/maps/{args.id}", data=json.dumps(rec).encode(), method="PUT",
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()
    print(f"saved {args.id}: {len(placements)} placements over {len(by_cat)} categories, map size {size}")
    if args.open:
        with urllib.request.urlopen(f"{args.base}/api/debug/command?action=open&uid={args.id}", timeout=30) as r:
            print(r.read().decode())


if __name__ == "__main__":
    main()
