"""Rank blocks by how much their review sheet changed between two runs of
tools/block_sheets.py (e.g. before/after an importer change):

    python tools/sheet_diff.py sheets_before sheets_after [--top 40]

Prints the blocks whose renders differ most, so a broad re-import can be
spot-checked by eye instead of re-reviewing every sheet."""
import argparse, os, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageStat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("before"); ap.add_argument("after")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--min", type=float, default=1.0, help="ignore scores below this")
    a = ap.parse_args()
    before = {p.name.split("_", 1)[1]: p for p in Path(a.before).glob("*.png")}
    rows = []
    for p in Path(a.after).glob("*.png"):
        q = before.get(p.name.split("_", 1)[1])
        if q is None:
            rows.append((999.0, p.stem.split("_", 1)[1], "new")); continue
        x = Image.open(p).convert("L"); y = Image.open(q).convert("L")
        if x.size != y.size: y = y.resize(x.size)
        score = ImageStat.Stat(ImageChops.difference(x, y)).mean[0]
        rows.append((score, p.stem.split("_", 1)[1], ""))
    rows.sort(reverse=True)
    shown = 0
    for score, name, note in rows:
        if score < a.min: break
        print(f"{score:7.2f}  {name} {note}"); shown += 1
        if shown >= a.top: break
    print(f"{sum(1 for r in rows if r[0] >= a.min)} of {len(rows)} sheets changed (score >= {a.min})")


if __name__ == "__main__":
    main()
