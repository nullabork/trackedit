"""Clip-placement diagnostic: for every exported block, check that each
merged CLIP chunk actually sits against the block's body on its assigned
face — instead of floating, landing on the wrong side, or being rotated
into the wrong plane. Aggregates failures by (clip, face) so systematic
transform bugs stand out from one-off oddities.

Needs the .obj.src.json sidecars (meshdump writes them per variant).

usage: python tools/diagnose_clips.py [air|ground] [nameFilter]
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MESHES = ROOT / "public" / "meshes"

VARIANT = sys.argv[1] if len(sys.argv) > 1 else "air"
FILTER = sys.argv[2] if len(sys.argv) > 2 else None

# Per face: (axis index, expected side sign vs unit centre, face plane coord)
FACES = {
    "north": (2, +1, 32.0),
    "south": (2, -1, 0.0),
    "east": (0, +1, 32.0),
    "west": (0, -1, 0.0),
    "top": (1, +1, 8.0),
    "bottom": (1, -1, 0.0),
}
UNIT = (32.0, 8.0, 32.0)


def bbox(verts, idxs):
    xs = [verts[i][0] for i in idxs]
    ys = [verts[i][1] for i in idxs]
    zs = [verts[i][2] for i in idxs]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def gap(a, b):
    """Largest axis gap between two AABBs (0 = touching/overlapping)."""
    g = 0.0
    for i in range(3):
        g = max(g, a[0][i] - b[1][i], b[0][i] - a[1][i])
    return g


issues = Counter()
examples = defaultdict(list)
blocks_with_issues = set()
checked_blocks = 0
checked_clips = 0

for src_file in sorted(MESHES.glob(f"*/{VARIANT}.obj.src.json")):
    block = src_file.parent.name
    if FILTER and FILTER.lower() not in block.lower():
        continue
    obj_file = src_file.parent / f"{VARIANT}.obj"
    if not obj_file.exists():
        continue
    sources = json.loads(src_file.read_text())
    if not any(s["src"].startswith("clip:") for s in sources):
        continue

    verts = []
    for line in obj_file.open(encoding="utf-8", errors="ignore"):
        if line.startswith("v "):
            p = line.split()
            verts.append((float(p[1]), float(p[2]), float(p[3])))

    checked_blocks += 1
    mobil_idx = []
    clip_ranges = defaultdict(list)
    for s in sources:
        rng = range(s["start"] - 1, s["start"] - 1 + s["count"])
        if s["src"].startswith("clip:"):
            clip_ranges[s["src"]].extend(rng)
        else:
            mobil_idx.extend(rng)

    mobil_box = bbox(verts, mobil_idx) if mobil_idx else None

    for src, idxs in clip_ranges.items():
        _, clip_id, face, unit_s = src.split(":")
        ux, uy, uz = (int(v) for v in unit_s.split(","))
        axis, sign, plane = FACES.get(face, (2, +1, 32.0))
        unit_min = (ux * 32.0, uy * 8.0, uz * 32.0)
        centre = tuple(unit_min[i] + UNIT[i] / 2 for i in range(3))

        checked_clips += 1
        box = bbox(verts, idxs)
        mid = tuple((box[0][i] + box[1][i]) / 2 for i in range(3))
        ext = tuple(box[1][i] - box[0][i] for i in range(3))

        def flag(kind):
            key = (clip_id, face, kind)
            issues[key] += 1
            if len(examples[key]) < 3:
                examples[key].append(block)
            blocks_with_issues.add(block)

        # 1) caps must TOUCH their face plane (sloped caps may rise/extend,
        #    but their near edge belongs at the face).
        face_pos = unit_min[axis] + (UNIT[axis] if sign > 0 else 0.0)
        # End caps carry bumper trims that overhang up to ~3.5 units.
        near = box[0][axis] if sign < 0 else box[1][axis]
        if abs(near - face_pos) > 4.0:
            flag("off-face")

        # 2) detached from the REST of the block entirely (floating): gap
        #    versus the union of everything else that was merged.
        other_idx = list(mobil_idx)
        for other_src, oi in clip_ranges.items():
            if other_src != src:
                other_idx.extend(oi)
        if other_idx:
            rest_box = bbox(verts, other_idx)
            if gap(box, rest_box) > 2.0:
                flag("floating")

        # 3) suspicious orientation: a side clip squashed flat along a
        #    TANGENT axis (i.e. it became a thin sliver in the wrong plane).
        if face in ("north", "south", "east", "west"):
            tangents = [i for i in range(3) if i != axis and i != 1]
            if ext[tangents[0]] < 0.6 and ext[axis] > 4.0:
                flag("rotated?")

print(f"checked {checked_blocks} blocks / {checked_clips} clip merges ({VARIANT})")
print(f"blocks with at least one flagged clip: {len(blocks_with_issues)}\n")
if not issues:
    print("no issues flagged")
for (clip_id, face, kind), n in issues.most_common(40):
    ex = ", ".join(examples[(clip_id, face, kind)])
    print(f"{n:5d}  {kind:14s} {face:6s} {clip_id}   e.g. {ex}")
