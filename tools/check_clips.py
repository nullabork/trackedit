"""Library-wide clip placement check: which exported blocks have attached clip
geometry hanging outside the block's own footprint.

    python tools/check_clips.py                 # all of public/meshes
    python tools/check_clips.py --top 30        # longest list
    python tools/check_clips.py --only DecoWall # name filter
    python tools/check_clips.py <meshes dir>

A clip (end cap, wall panel, underside) belongs inside the cells of the block
it is attached to; vertices more than `--slack` units outside the block's
[0, cells*32] x/z box mean it was turned the wrong way or attached to the
wrong face.  Reports per-block overhang and a summary, exit code 1 when any
block overhangs, so it can be compared before/after a meshdump change.
Blocks whose clips overhang by design (curved walls that wrap the neighbouring
cell) show up too; compare counts, not just presence.
"""
import argparse
import json
import sys
from pathlib import Path


def overhang(obj_path, size, slack):
    src = json.loads(open(str(obj_path) + ".src.json").read())
    verts = []
    used = set()
    with open(obj_path) as fh:
        for line in fh:
            if line.startswith("v "):
                _, x, y, z = line.split()[:4]
                verts.append((float(x), float(y), float(z)))
            elif line.startswith("f "):
                # Only vertices a face still references count: meshdump trims
                # cap triangles to the block footprint but keeps the vertex list.
                for tok in line.split()[1:]:
                    used.add(int(tok.split("/")[0]) - 1)
    sx, _, sz = size
    x_hi, z_hi = sx * 32, sz * 32
    bad = {}
    for s in src:
        name = s["src"]
        if name == "mobil":
            continue
        lo = s["start"] - 1
        vs = [verts[i] for i in range(lo, lo + s["count"]) if i in used]
        if not vs:
            continue
        outside = [
            v for v in vs
            if v[0] < -slack or v[0] > x_hi + slack or v[2] < -slack or v[2] > z_hi + slack
        ]
        if outside:
            worst = max(
                max(-v[0], v[0] - x_hi, -v[2], v[2] - z_hi) for v in outside
            )
            k = name.split(":")[1] + ":" + name.split(":")[2]
            cur = bad.get(k, (0, 0.0, 0))
            bad[k] = (cur[0] + len(outside), max(cur[1], worst), cur[2] + len(vs))
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=str(Path(__file__).resolve().parent.parent / "public/meshes"))
    ap.add_argument("--slack", type=float, default=1.0)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--only")
    args = ap.parse_args()
    root = Path(args.root)
    index = json.loads((root / "index.json").read_text())["blocks"]

    rows = []
    checked = 0
    for name, entry in sorted(index.items()):
        if args.only and args.only.lower() not in name.lower():
            continue
        size = entry.get("size") or [1, 1, 1]
        for variant in ("air", "ground"):
            rel = entry.get(variant)
            if not rel or not rel.startswith(name + "/"):
                continue  # aliases share another block's OBJ
            obj = root / rel
            if not obj.exists() or not Path(str(obj) + ".src.json").exists():
                continue
            checked += 1
            bad = overhang(obj, size, args.slack)
            for clip, (n_out, worst, n_all) in bad.items():
                rows.append((worst, name, variant, clip, n_out, n_all))

    rows.sort(reverse=True)
    blocks = {(r[1], r[2]) for r in rows}
    print(f"checked {checked} block variants; {len(blocks)} with clip geometry outside the footprint "
          f"(slack {args.slack}), {len(rows)} clip attachments")
    for worst, name, variant, clip, n_out, n_all in rows[: args.top]:
        print(f"  {worst:6.1f}u  {name}/{variant}  {clip}  ({n_out}/{n_all} verts outside)")
    return 1 if rows else 0


if __name__ == "__main__":
    sys.exit(main())
