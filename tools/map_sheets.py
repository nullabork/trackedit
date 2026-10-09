"""One review tile per BLOCK TYPE a map uses (not per placement): the first placement of
each type, isolated, from the game's icon camera (yaw 315, pitch -30), with the game's own
icon beside it when there is one — a sweep of a whole map's vocabulary in a few hundred
tiles instead of its ten thousand placements.

    python tools/map_sheets.py [--map <id>] [--out sheets/map_<id>] [--items] [--kind block|free|item]

Tiles are named <n>_<block>.png in the layout tools/icon_match.py scores (first 640 px =
the isolated render under a 28 px header), so `python tools/icon_match.py <out> sheets/icons`
ranks the types whose silhouette least resembles the game's render. Contact sheets of 12
tiles (<out>/sheet_<k>.jpg) are for eyeballing. The editor tab must be open on the map.
"""
import argparse
import io
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw


def get(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://localhost:5199")
    ap.add_argument("--map")
    ap.add_argument("--out")
    ap.add_argument("--icons", default=os.path.join("sheets", "icons"))
    ap.add_argument("--kind", default="all", help="block (grid), free (free blocks), item, or all")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    map_id = a.map or json.loads(get(f"{a.base}/api/debug/state"))["state"]["map"]["id"]
    out = Path(a.out or os.path.join("sheets", f"map_{map_id}"))
    out.mkdir(parents=True, exist_ok=True)
    doc = json.loads(get(f"{a.base}/api/maps/{map_id}"))
    first = {}

    def walk(o):
        if isinstance(o, dict):
            if o.get("block") and o.get("kind") and "id" in o:
                kind = "item" if o.get("isItem") else o["kind"]
                if a.kind in ("all", kind) and o["block"] not in first:
                    first[o["block"]] = o
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(doc)
    names = sorted(first)
    if a.limit:
        names = names[: a.limit]
    print(f"{len(names)} types on {map_id} -> {out}")
    tiles = []
    for n, name in enumerate(names, 1):
        p = first[name]
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", name.replace("\\", "/").rsplit("/", 1)[-1])[:70]
        path = out / f"{n:03}_{safe}.png"
        try:
            png = get(f"{a.base}/api/debug/screenshot?target=selection&uid={p['id']}&isolate=1&yaw=315&pitch=-30")
            shot = Image.open(io.BytesIO(png)).convert("RGB")
        except Exception as e:  # noqa: BLE001
            print(f"  {name}: {e}")
            continue
        w, h = shot.size
        view = shot.crop((w // 4, h // 5, 3 * w // 4, 4 * h // 5)).resize((640, 386))
        icon_path = Path(a.icons) / f"{name}.png"
        icon = Image.open(icon_path).transpose(Image.FLIP_TOP_BOTTOM).convert("RGB").resize((386, 386)) if icon_path.exists() else None
        tile = Image.new("RGB", (640 + 386, 386 + 28), "white")
        ImageDraw.Draw(tile).text((4, 6), f"{n:03} {name[:60]}  ({p['kind']}{', item' if p.get('isItem') else ''}, dir {p.get('dir', p.get('rot'))})", fill="black")
        tile.paste(view, (0, 28))
        if icon:
            tile.paste(icon, (640, 28))
        tile.save(path)
        tiles.append(tile)
        if n % 25 == 0:
            print(f"  {n}/{len(names)}")
    for k in range(0, len(tiles), 12):
        sheet = Image.new("RGB", (1026 * 3, 414 * 4), "white")
        for i, t in enumerate(tiles[k:k + 12]):
            sheet.paste(t, ((i % 3) * 1026, (i // 3) * 414))
        sheet.save(out / f"sheet_{k // 12:02}.jpg", quality=80)
    print("done")


if __name__ == "__main__":
    sys.exit(main())
