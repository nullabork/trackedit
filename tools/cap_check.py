#!/usr/bin/env python3
"""Developer check: do top/bottom caps sit where the rest of their block is?

Blocks get their undersides and top plates from CLIP pieces ("caps") that
the extractor merges into the block's mesh as OBJ groups named
`clip:<id>:top|bottom:<unit>`. A cap turned the wrong way is the classic
"black section sticks out past the curve" bug: a quarter-round wall whose
quarter-disc underside points away from the wall.

The test is purely geometric, so it judges the RESULT whatever rule placed
the cap: seen from above, a cap has to lie inside the outline (convex hull)
of everything else in its block — body and side walls. For every extracted
block and variant this reports caps with vertices outside that outline.

  python tools/cap_check.py [meshes dir] [--json report.json] [--filter Name]

Two kinds of block are left out, because the test cannot speak for them:
blocks whose other geometry does not outline them (a lone wall panel says
nothing about where a square cap belongs — the outline has to cover at
least 30 % of the cap's own), and ground variants' "...Ground" undersides,
which are terrain-blend skirts that spread past the block on purpose.

Exit code 1 when any cap sticks out (tolerance: 1.5 m, 8 % of a cap's
vertices). Not an editor feature — run it after touching the extractor.
"""
import argparse, json, os, re, sys

TOLERANCE_M = 1.5
ALLOWED_FRACTION = 0.08


def load_groups(path):
    verts, groups, current = [], {}, None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("v "):
                p = line.split()
                verts.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("g "):
                current = line[2:].strip()
                groups.setdefault(current, set())
            elif line.startswith("f ") and current is not None:
                for tok in line.split()[1:]:
                    groups[current].add(int(tok.split("/")[0]) - 1)
    return {g: [verts[i] for i in ids] for g, ids in groups.items() if ids}


def hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def outside_distance(p, poly):
    """How far p lies outside a convex polygon given counter-clockwise (0 inside)."""
    worst = 0.0
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ex, ez = b[0] - a[0], b[1] - a[1]
        length = (ex * ex + ez * ez) ** 0.5
        if length < 1e-9:
            continue
        # Signed distance to the edge's line; negative = outside for a CCW polygon.
        d = (ex * (p[1] - a[1]) - ez * (p[0] - a[0])) / length
        worst = max(worst, -d)
    return worst


def area(poly):
    return abs(sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))) / 2


def check(path):
    groups = load_groups(path)
    caps = {g: v for g, v in groups.items() if re.match(r"clip:[^:]+:(top|bottom):", g)}
    rest = [(x, z) for g, v in groups.items() if g not in caps for x, _, z in v]
    if not caps or len(set(rest)) < 3:
        return []
    outline = hull(rest)
    if len(outline) < 3:
        return []
    problems = []
    for name, v in caps.items():
        if re.search(r"Ground:bottom:", name):
            continue  # a terrain-blend skirt: meant to spread
        own = hull([(x, z) for x, _, z in v])
        if len(own) < 3 or area(outline) < 0.3 * area(own):
            continue  # the rest of the block does not outline it
        far = [outside_distance((x, z), outline) for x, _, z in v]
        out = sum(1 for d in far if d > TOLERANCE_M)
        if out / len(v) > ALLOWED_FRACTION:
            problems.append({"cap": name, "vertices": len(v), "outside": out, "worst_m": round(max(far), 1)})
    return problems


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("meshes", nargs="?", default=os.path.join(os.path.dirname(__file__), "..", "public", "meshes"))
    ap.add_argument("--json", help="write the full report here")
    ap.add_argument("--filter", help="only blocks whose name contains this")
    args = ap.parse_args()

    index = json.load(open(os.path.join(args.meshes, "index.json"), encoding="utf-8"))["blocks"]
    report, checked = {}, 0
    for block, entry in sorted(index.items()):
        if args.filter and args.filter.lower() not in block.lower():
            continue
        for key, rel in entry.items():
            if not re.fullmatch(r"(air|ground)\d*", key) or not rel:
                continue
            path = os.path.join(args.meshes, rel)
            if not os.path.exists(path):
                continue
            checked += 1
            problems = check(path)
            if problems:
                report.setdefault(block, {})[key] = problems
    caps = sum(len(p) for v in report.values() for p in v.values())
    print(f"{checked} block meshes checked: {len(report)} blocks have caps sticking out of their outline ({caps} caps)")
    families = {}
    for block in report:
        fam = re.match(r"[A-Z][a-z]+(?:[A-Z][a-z]+)?", block)
        families[fam.group(0) if fam else block] = families.get(fam.group(0) if fam else block, 0) + 1
    for fam, n in sorted(families.items(), key=lambda kv: -kv[1])[:25]:
        print(f"  {n:4d}  {fam}")
    if args.json:
        json.dump(report, open(args.json, "w", encoding="utf-8"), indent=1)
        print(f"report: {args.json}")
    return 1 if report else 0


if __name__ == "__main__":
    sys.exit(main())
