"""Developer check: does every clip a block lists actually have geometry in its mesh?

index.json lists, per block variant, the clips on each unit face; the mesh carries each one
as a part named "clip:<id>:<face>:<unit>". A listed clip WITHOUT a part is a surface the
editor can never draw, however right the visibility rule is: the extractor dropped it — no
geometry in the variant it needed, or its placement check rejected it. That check used to
ask "does the clip touch the block's body?", which fails every thin-walled block: 234 outer
wall faces, 258 loop-start back panels and 2,932 underside plates were lost to it (NOTES 5o).

Reads the small .src.json sidecars, not the OBJs. Lists what is missing by clip; the count
is the number to drive down, and each line names example blocks to look at.

usage: python tools/clip_geometry_check.py [meshesDir]           (npm run clipgeom)
"""
import collections
import json
import os
import sys

meshes = sys.argv[1] if len(sys.argv) > 1 else os.path.join("public", "meshes")
index = json.load(open(os.path.join(meshes, "index.json"), encoding="utf-8"))["blocks"]

missing = collections.Counter()
examples = collections.defaultdict(set)
listed = variants = 0
for name, entry in index.items():
    for tag, clips in (entry.get("clips") or {}).items():
        path = entry.get(tag)
        if not path or not clips:
            continue
        sidecar = os.path.join(meshes, path + ".src.json")
        if not os.path.exists(sidecar):
            continue
        try:
            have = {s["src"] for s in json.load(open(sidecar, encoding="utf-8"))}
        except (OSError, ValueError):
            continue
        variants += 1
        for c in clips:
            listed += 1
            part = f"clip:{c['id']}:{c['face']}:{','.join(map(str, c['u']))}"
            if part not in have:
                kind = c["face"] if c["face"] in ("top", "bottom") else "side"
                missing[(c["id"], kind)] += 1
                examples[(c["id"], kind)].add(name)

total = sum(missing.values())
print(f"{variants} variant meshes, {listed} clips listed: {total} have no geometry in the mesh ({100 * total / max(listed, 1):.1f}%)")
for (clip, kind), n in missing.most_common(30):
    print(f"  {n:5} x {clip} ({kind})   e.g. {', '.join(sorted(examples[(clip, kind)])[:2])}")
