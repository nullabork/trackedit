"""Score every review sheet against the game's own block icon.

    python tools/icon_match.py sheets/catalog sheets/icons [--top 40]

Sheet view 1 (yaw 315, pitch -30) is the icon camera; the game stores the
icons bottom-up, so they are flipped on load. Both images are reduced
to silhouettes (icon: alpha; sheet: non-background pixels of the first tile,
ignoring the thin green outlines of other placements), fitted to a common
box and compared by intersection-over-union. Low scores mean the exported
shape does not resemble the game's render — the list to eyeball first."""
import argparse
from pathlib import Path
import numpy as np
from PIL import Image


def sheet_silhouette(path: Path, tile_w: int = 640) -> np.ndarray | None:
    im = np.asarray(Image.open(path).convert("RGB"))[28:, :tile_w].astype(int)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    white = (r > 235) & (g > 235) & (b > 235)
    greenish = (g > r + 25) & (g > b + 25) & (g > 120)   # placement outlines
    return ~white & ~greenish


def icon_silhouette(path: Path) -> np.ndarray:
    a = np.asarray(Image.open(path).convert("RGBA"))[::-1, :, 3]  # stored bottom-up
    return a > 40


def fit(mask: np.ndarray, size: int = 96) -> np.ndarray | None:
    ys, xs = np.nonzero(mask)
    if len(ys) < 20: return None
    crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    im = Image.fromarray((crop * 255).astype(np.uint8)).resize((size, size), Image.BILINEAR)
    return np.asarray(im) > 127


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheets"); ap.add_argument("icons")
    ap.add_argument("--top", type=int, default=40)
    a = ap.parse_args()
    rows = []
    for p in sorted(Path(a.sheets).glob("*.png")):
        name = p.stem.split("_", 1)[1]
        ic = Path(a.icons) / f"{name}.webp"
        if not ic.exists(): continue
        im = icon_silhouette(ic)
        if im.mean() < 0.08:
            continue  # blank or wireframe-only icon: nothing to compare against
        s = fit(sheet_silhouette(p)); i = fit(im)
        if s is None or i is None:
            rows.append((0.0, name, "empty")); continue
        iou = (s & i).sum() / max(1, (s | i).sum())
        rows.append((float(iou), name, ""))
    rows.sort()
    for iou, name, note in rows[:a.top]:
        print(f"{iou:5.2f}  {name} {note}")
    scores = [r[0] for r in rows]
    print(f"{len(rows)} blocks, median IoU {np.median(scores):.2f}")


if __name__ == "__main__":
    main()
