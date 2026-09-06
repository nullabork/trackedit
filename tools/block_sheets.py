"""Contact sheets of every placement in a map, isolated, from several angles.

Drives the dev server's debug bridge (the editor tab must be open):

    python tools/block_sheets.py                # map currently open in the editor
    python tools/block_sheets.py --map map_21_2y5s --out sheets --reload

One PNG per placement: <n>_<block>.png with three views side by side
(front-left high, back-right high, front-right low). Review them in bulk to
spot misplaced clips, wrong surfaces, or missing parts without clicking
through the map by hand.  --reload refreshes the tab first so a re-import is
picked up.  --only <substring> limits to matching block names.
"""
import argparse
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("needs Pillow: pip install pillow")

VIEWS = [("front-left", 45, -30), ("back-right", 225, -30), ("front-right low", 135, -8)]


def get(url, timeout=40):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def placements(base, map_id):
    doc = json.loads(get(f"{base}/api/maps/{map_id}"))

    def walk(o):
        if isinstance(o, dict):
            if "block" in o and ("coord" in o or "pos" in o):
                yield o
            for v in o.values():
                yield from walk(v)
        elif isinstance(o, list):
            for v in o:
                yield from walk(v)

    return list(walk(doc))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://localhost:5199")
    ap.add_argument("--map", help="map id (default: the one open in the editor)")
    ap.add_argument("--out", default="sheets")
    ap.add_argument("--only", help="substring filter on block names")
    ap.add_argument("--reload", action="store_true", help="reload the editor tab first")
    ap.add_argument("--width", type=int, default=640, help="width of each view in the sheet")
    args = ap.parse_args()

    if args.reload:
        get(f"{args.base}/api/debug/command?action=reload")
        time.sleep(10)
    state = json.loads(get(f"{args.base}/api/debug/state"))["state"]
    map_id = args.map or state["map"]["id"]
    if args.map and state["map"]["id"] != args.map:
        # The bridge screenshots the map the tab has open — switch it.
        get(f"{args.base}/api/debug/command?action=open&uid={args.map}")
        time.sleep(4)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    items = placements(args.base, map_id)
    if args.only:
        items = [p for p in items if args.only.lower() in p["block"].lower()]
    print(f"{len(items)} placements in {map_id}")
    w = args.width
    for n, p in enumerate(items, 1):
        uid, block = p["id"], p["block"]
        tiles = []
        for label, yaw, pitch in VIEWS:
            url = f"{args.base}/api/debug/screenshot?uid={uid}&yaw={yaw}&pitch={pitch}&isolate=1"
            try:
                img = Image.open(io.BytesIO(get(url))).convert("RGB")
            except Exception as ex:  # keep going; note the failure on the sheet
                img = Image.new("RGB", (w, int(w * 0.66)), "white")
                ImageDraw.Draw(img).text((10, 10), f"{label}: {ex}", fill="red")
            h = int(img.height * w / img.width)
            tiles.append(img.resize((w, h)))
        sheet_h = max(t.height for t in tiles) + 28
        sheet = Image.new("RGB", (w * len(tiles), sheet_h), "white")
        for i, t in enumerate(tiles):
            sheet.paste(t, (i * w, 28))
        d = ImageDraw.Draw(sheet)
        d.text((8, 6), f"{n:02d} {block}  ({uid}, dir {p.get('dir', '-')})", fill="black")
        for i, (label, yaw, pitch) in enumerate(VIEWS):
            d.text((i * w + 8, 16), f"{label} yaw {yaw} pitch {pitch}", fill="gray")
        path = out / f"{n:02d}_{block}.png"
        sheet.save(path)
        print(f"  {path}")


if __name__ == "__main__":
    main()
