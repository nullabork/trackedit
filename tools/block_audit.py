"""Developer audit: does each exported block LOOK like a block? Geometry and colour sanity
over the mesh library, by rules a track piece should obey, listed per block so the rest of
a class can be found once one is reported:

  bottom-above   a bottom cap (clip:*:bottom:*) whose lowest point lies above the body's top
                 over the same ground - an underside drawn on top of the road
  top-below      a top cap entirely under the body
  floating       a part (body or clip) more than 1 m clear of every other part of the block -
                 track pieces are connected; a plate hanging in the air is misplaced
  surface        the block's name says Dirt / Grass / Ice / Snow / Plastic / Water / Wood,
                 but no material of that family is on it - the driving surface is drawn in
                 another material's colour (blue "dirt")
  flat           a material drawn without a texture (plain colour), unless it is translucent,
                 water or self-lit by design

  continuity   (--map only) two placed decks that touch along a shared edge but part by 2 m
                 elsewhere along it — a piece turned the wrong way, or the wrong variant

usage: python tools/block_audit.py [--map <id>] [--only <substring>] [--names A B ...]
       (npm run blockaudit)   --map limits to the blocks a stored map uses; default: all.
"""
import argparse
import collections
import json
import os
import re

MESHES = os.path.join("public", "meshes")

# Block-name token -> the material families that carry that surface.
SURFACES = {
    "Dirt": ("Dirt",), "Grass": ("Grass",), "Ice": ("Ice",), "Snow": ("Snow",),
    "Plastic": ("Plastic",), "Water": ("Water",), "Wood": ("Wood",),
}
GAP = 1.0


def parse_obj(path):
    """Vertices, and per group+material the triangles' vertex indices (0-based)."""
    verts = []
    faces = collections.defaultdict(list)  # (group, material) -> [i, j, k, ...]
    group, mat = "body", ""
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            c = line[0] if line else ""
            if c == "v" and line[1] == " ":
                a = line.split()
                verts.append((float(a[1]), float(a[2]), float(a[3])))
            elif c == "f":
                ids = [int(t.split("/")[0]) - 1 for t in line.split()[1:]]
                faces[(group, mat)].extend(ids)
            elif c == "g":
                group = line[2:].strip()
            elif c == "u" and line.startswith("usemtl"):
                mat = line[7:].strip()
    return verts, faces


def bounds(verts, ids):
    xs = [verts[i][0] for i in ids]
    ys = [verts[i][1] for i in ids]
    zs = [verts[i][2] for i in ids]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def gap(a, b):
    """Distance between two boxes (0 when they touch or overlap)."""
    d = 0.0
    for k in range(3):
        d = max(d, a[0][k] - b[1][k], b[0][k] - a[1][k])
    return d


CELL = 8.0


def height_cells(verts, ids, pick):
    """Per 8 m XZ cell, the highest (pick=max) or lowest (pick=min) vertex y."""
    cells = {}
    for i in ids:
        x, y, z = verts[i]
        k = (int(x // CELL), int(z // CELL))
        cells[k] = y if k not in cells else pick(cells[k], y)
    return cells


def cap_against_body(verts, body_ids, cap_ids, face):
    """
    Cell by cell (a tilted underside is low on one side and high on the other, so one
    number for the whole plate says nothing): the share of cells where a bottom cap's
    lowest point lies ABOVE the body's highest (or a top cap's highest below the body's
    lowest), among the cells both occupy. None when they share no cell.
    """
    body = height_cells(verts, body_ids, max if face == "bottom" else min)
    cap = height_cells(verts, cap_ids, min if face == "bottom" else max)
    shared = [k for k in cap if k in body]
    if not shared:
        return None
    wrong = sum(1 for k in shared if (cap[k] > body[k] + 0.3 if face == "bottom" else cap[k] < body[k] - 0.3))
    return wrong / len(shared)


def audit_variant(name, path, materials):
    out = []
    verts, faces = parse_obj(path)
    if not verts:
        return out
    parts = collections.defaultdict(list)
    mats_used = set()
    for (group, mat), ids in faces.items():
        parts[group].extend(ids)
        mats_used.add(mat)
    boxes = {g: bounds(verts, ids) for g, ids in parts.items() if ids}
    body = parts.get("body", [])

    # caps against the body
    for g in boxes:
        if not g.startswith("clip:") or not body or "~" in g:
            continue
        face = g.split(":")[2] if g.count(":") >= 3 else ""
        if face not in ("bottom", "top"):
            continue
        share = cap_against_body(verts, body, parts[g], face)
        if share is not None and share >= 0.5:
            out.append(("bottom-above" if face == "bottom" else "top-below", f"{g}: {share:.0%} of its cells on the wrong side of the body"))

    # floating parts (alternates "~a/~b/~ab" are hidden until a neighbour wants them).
    # Only blocks with a body: a mesh-less block (a deco cliff ring, a stage support) is
    # nothing but clips around an empty cell, and those are meant to stand apart.
    shown = [g for g in boxes if "~" not in g]
    if len(shown) > 1 and body:
        for g in shown:
            nearest = min(gap(boxes[g], boxes[o]) for o in shown if o != g)
            if nearest > GAP:
                out.append(("floating", f"{g} is {nearest:.1f} m clear of the rest"))

    # surface family by name — driving pieces only (Road*, Platform*, Open*): a wall clip
    # named "...Water..." or "...ToGrass..." is named after what it joins, not what it is
    short = name.rsplit("\\", 1)[-1]
    if re.match(r"(Road|Platform|Open)", short) and not re.search(r"(FC|VFC|HFC)", short):
        for token, fams in SURFACES.items():
            if re.search(token, short) and not any(any(f in m for f in fams) for m in mats_used):
                out.append(("surface", f"name says {token}, materials are {', '.join(sorted(mats_used))}"))

    # flat materials
    for m in sorted(mats_used):
        e = materials.get(m)
        if e is None:
            out.append(("flat", f"{m}: not in materials.json"))
        elif not e.get("texture") and not (e.get("translucent") or e.get("water") or e.get("selfIllum") or e.get("color")):
            out.append(("flat", f"{m}: no texture"))
    return out


# --- deck continuity between neighbouring placements of a map (the editor's own transform) ---

def body_tops_world(meshes, index, p, cache):
    """Per 4 m world cell, the highest body vertex of a placed block, placed as the editor places it."""
    e = index.get(p["block"])
    if not e:
        return None, None
    flags = p.get("meta", {}).get("flags") or 0
    v = (flags >> 21) & 63
    base = "ground" if p.get("meta", {}).get("isGround") else "air"
    tag = f"{base}{v}" if v else base
    path = e.get(tag) if isinstance(e.get(tag), str) else e.get("air")
    if not isinstance(path, str):
        return None, None
    if path not in cache:
        verts, faces = parse_obj(os.path.join(meshes, path))
        cache[path] = (verts, sorted({i for (g, _m), ids in faces.items() if g == "body" for i in ids}))
    verts, body = cache[path]
    size = e.get("size", [1, 1, 1])
    d = p["dir"]
    rotated = d % 2 == 1
    sx, sz = (size[2], size[0]) if rotated else (size[0], size[2])
    ox, oy, oz = p["coord"][0] * 32 + sx * 16, p["coord"][1] * 8, p["coord"][2] * 32 + sz * 16
    import math
    a = -d * math.pi / 2
    c, s = math.cos(a), math.sin(a)
    tops = {}
    for i in body:
        x, y, z = verts[i]
        x -= size[0] * 16
        z -= size[2] * 16
        k = (int((x * c + z * s + ox) // 4), int((-x * s + z * c + oz) // 4))
        tops[k] = max(tops.get(k, -1e9), y + oy)
    # The deck, not what stands on it: cells whose top is 9 m or more above the block's
    # low quartile (a start gate's arch, a checkpoint's frame) are left out; a tilt is 8 m.
    if tops:
        ys = sorted(tops.values())
        deck = ys[len(ys) // 4]
        tops = {k: v for k, v in tops.items() if v < deck + 9}
    return tops, (p["coord"][0], p["coord"][2], sx, sz)


def continuity(meshes, index, placements):
    """
    Where two placed road pieces meet along a footprint edge, their decks should agree:
    flagged when the two decks touch somewhere along the edge (within 1 m) but part by 2 m
    or more elsewhere along it — a piece turned the wrong way, or the wrong variant. Two
    decks that never come within 1 m are not joined at all and are left alone.
    """
    cache = {}
    tops = {}
    # Driving pieces only: a grandstand's steps or a cliff's slope part from a road by design.
    placements = [p for p in placements if re.match(r"(Road|Platform|Open)", p["block"].rsplit("\\", 1)[-1])]
    for p in placements:
        t, fp = body_tops_world(meshes, index, p, cache)
        if t:
            tops[p["id"]] = (p, t, fp)
    out = []
    for pid, (p, mine, (x0, z0, sx, sz)) in tops.items():
        sides = [
            ("-x", [((x0 * 8, t), (x0 * 8 - 1, t)) for t in range(z0 * 8, (z0 + sz) * 8, 2)]),
            ("+x", [(((x0 + sx) * 8 - 1, t), ((x0 + sx) * 8, t)) for t in range(z0 * 8, (z0 + sz) * 8, 2)]),
            ("-z", [((t, z0 * 8), (t, z0 * 8 - 1)) for t in range(x0 * 8, (x0 + sx) * 8, 2)]),
            ("+z", [((t, (z0 + sz) * 8 - 1), (t, (z0 + sz) * 8)) for t in range(x0 * 8, (x0 + sx) * 8, 2)]),
        ]
        for side, pairs in sides:
            for qid, (q, theirs, _fp) in tops.items():
                if qid == pid:
                    continue
                diffs = [abs(mine[a] - theirs[b]) for a, b in pairs if a in mine and b in theirs]
                if len(diffs) >= 2 and min(diffs) <= 1.0 and max(diffs) >= 2.0:
                    out.append((p, side, q, min(diffs), max(diffs)))
    return out


def map_blocks(map_id):
    doc = json.load(open(os.path.join("maps", map_id + ".json"), encoding="utf-8"))
    wanted = set()

    def walk(o):
        if isinstance(o, dict):
            if "block" in o and not o.get("isItem"):
                wanted.add(o["block"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(doc)
    return wanted


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--map", help="stored map id (maps/<id>.json): only the blocks it uses")
    ap.add_argument("--only", help="substring of the block name")
    ap.add_argument("--names", nargs="*")
    ap.add_argument("--meshes", default=MESHES)
    a = ap.parse_args()
    index = json.load(open(os.path.join(a.meshes, "index.json"), encoding="utf-8"))["blocks"]
    materials = json.load(open(os.path.join(a.meshes, "materials.json"), encoding="utf-8"))
    wanted = map_blocks(a.map) if a.map else None
    if a.map and not a.names and not a.only:
        doc = json.load(open(os.path.join("maps", a.map + ".json"), encoding="utf-8"))
        placements = []

        def collect(o):
            if isinstance(o, dict):
                if o.get("kind") == "block" and "coord" in o and "id" in o:
                    placements.append(o)
                for v in o.values():
                    collect(v)
            elif isinstance(o, list):
                for v in o:
                    collect(v)
        collect(doc)
        joins = continuity(a.meshes, index, placements)
        if joins:
            print(f"deck continuity: {len(joins)} edges where two decks touch but part along the edge")
            for p, side, q, lo, hi in joins[:60]:
                print(f"   {p['id']} {p['block']} {p['coord']} dir {p['dir']} side {side} vs {q['block']} {q['coord']} dir {q['dir']}: {lo:.1f}..{hi:.1f} m apart")

    if a.names:
        wanted = set(a.names)
    counts = collections.Counter()
    blocks_flagged = 0
    checked = 0
    for name in sorted(index):
        if wanted is not None and name not in wanted:
            continue
        if a.only and a.only.lower() not in name.lower():
            continue
        findings = []
        for tag, path in index[name].items():
            if not isinstance(path, str) or not path.endswith(".obj") or "@" in tag:
                continue
            full = os.path.join(a.meshes, path)
            if not os.path.exists(full):
                continue
            checked += 1
            for kind, what in audit_variant(name, full, materials):
                findings.append((tag, kind, what))
        if findings:
            blocks_flagged += 1
            print(name)
            for tag, kind, what in findings:
                counts[kind] += 1
                print(f"   [{tag}] {kind}: {what}")
    print(f"\n{checked} variant meshes checked, {blocks_flagged} blocks flagged: " + ", ".join(f"{k} {n}" for k, n in counts.most_common()))


if __name__ == "__main__":
    main()
