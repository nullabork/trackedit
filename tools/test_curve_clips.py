"""Regression checks against exported curve geometry, including attachment provenance.

Run after meshdump blocks: python tools/test_curve_clips.py [mesh-directory]
Requires the user's extracted RoadTechCurve1 and RoadTechTiltCurve1 air and ground meshes.
These curves have open ends at x=0 and z=32; their curved outer wall must not
receive an end cap at x=32. A mere bounding-box overlap check misses that error.
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "public/meshes"

for block, variant in ((b, v) for b in ("RoadTechCurve1", "RoadTechTiltCurve1") for v in ("air", "ground")):
    path = root / block / f"{variant}.obj"
    vertices = [tuple(map(float, line.split()[1:])) for line in path.read_text().splitlines() if line.startswith("v ")]
    groups = defaultdict(list)
    for entry in json.loads(path.with_suffix(".obj.src.json").read_text()):
        start = entry["start"] - 1
        groups[entry["src"]].extend(vertices[start:start + entry["count"]])

    faces = set()
    for source, points in groups.items():
        if not source.startswith("clip:"):
            continue
        _, clip, face, unit = source.split(":")
        faces.add(face)
        if face not in ("east", "north"):
            continue
        assert unit.split(",")[0::2] == ["0", "0"], (block, source, "unexpected horizontal unit")
        axis, plane = (0, 0) if face == "east" else (2, 32)
        lo, hi = min(p[axis] for p in points), max(p[axis] for p in points)
        assert lo - 0.1 <= plane <= hi + 0.1, (block, clip, "misses open end", lo, hi)
        # Ground wall prefabs can extend several cells; road caps cannot.
        if not clip.startswith("RoadTech"):
            continue
        assert max(abs(lo - plane), abs(hi - plane)) < 6, (block, clip, "extends across curved wall", lo, hi)
    assert {"east", "north", "bottom"} <= faces, (block, "missing end/underside geometry", faces)
    print(f"{block}/{variant}: end caps meet open ends; underside retained")

    if block == "RoadTechTiltCurve1":
        # At each open end, the cap's high/low edges must meet the body's
        # high/low edges. Being on the correct face alone is insufficient.
        body = groups["mobil"]
        for source, points in groups.items():
            if not source.startswith("clip:RoadTechFCTilt"):
                continue
            face = source.split(":")[2]
            axis, plane, tangent = (2, 32, 0) if face == "north" else (0, 0, 2)
            for end in (2, 30):
                def edge_height(ps):
                    return max(p[1] for p in ps if abs(p[axis] - plane) < 0.7 and abs(p[tangent] - end) < 1.5)
                assert abs(edge_height(points) - edge_height(body)) < 0.1, (block, source, end, "cap slope reversed")
        print(f"{block}/{variant}: banked end-cap profiles match the road")
