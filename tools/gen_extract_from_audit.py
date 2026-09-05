"""Build the Openplanet extract list from the coverage audit: exact game
paths for every catalog block/item that has no geometry yet (their pak names
are hashed, so Pack Explorer never extracted them), plus everything the
ref-table `missing` scan found.

usage: python tools/gen_extract_from_audit.py
writes tools/meshdump/extract_list.txt and copies it into the plugin folder.
"""

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MISSING = ROOT / "tools" / "meshdump" / "missing_files.txt"
OUT = ROOT / "tools" / "meshdump" / "extract_list.txt"
PLUGIN = Path.home() / "OpenplanetNext" / "Plugins" / "TrackeditExtract" / "extract_list.txt"
EXTRACT_PREFIX = str(Path.home() / "OpenplanetNext" / "Extract") + "\\"

catalog = json.loads((ROOT / "public" / "catalog.json").read_text(encoding="utf-8"))
index = json.loads((ROOT / "public" / "meshes" / "index.json").read_text(encoding="utf-8"))

paths: set[str] = set()

# 1) everything the ref-table scan says is missing (+ texture-name candidates)
if MISSING.exists():
    for line in MISSING.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(EXTRACT_PREFIX):
            paths.add(line[len(EXTRACT_PREFIX):])
tex = re.compile(r"^(.*)\\Media\\(?:Material\\([^\\]+)\.Material|Texture\\([^\\]+)\.Texture)\.Gbx$", re.I)
for p in list(paths):
    m = tex.match(p)
    if not m:
        continue
    base = m.group(1)
    name = m.group(2) or m.group(3)
    sufs = ["D", "N", "R", "L", "I", "D_HueMask"] if m.group(2) else [""]
    for s in sufs:
        n = f"{name}_{s}" if s else name
        paths.add(f"{base}\\Media\\Texture\\{n}.Texture.gbx")
        paths.add(f"{base}\\Media\\Texture\\Image\\{n}.dds")
        paths.add(f"{base}\\Media\\Texture\\Image\\{n}.tga")

# 2) catalog blocks without geometry -> their BlockInfo files by exact name
missing_blocks = [b["name"] for b in catalog["blocks"] if b["name"] not in index["blocks"]]
for name in missing_blocks:
    for sub, ext in [
        ("GameCtnBlockInfoClassic", "EDClassic"),
        ("GameCtnBlockInfoFlat", "EDFlat"),
        ("GameCtnBlockInfoPillar", "EDClassic"),
        ("GameCtnBlockInfoClassic\\Deprecated", "EDClassic"),
    ]:
        paths.add(f"GameData\\Stadium\\GameCtnBlockInfo\\{sub}\\{name}.{ext}.Gbx")

# 3) catalog items without geometry -> Item.Gbx by exact name (root + likely folders)
idx_items = index.get("items", {})
missing_items = [i["name"] for i in catalog["items"]
                 if i["name"] not in idx_items and i["name"] not in index["blocks"]]
for name in missing_items:
    for folder in ["", "Vegetation\\", "Obstacles\\", "Trees\\"]:
        paths.add(f"GameData\\Stadium\\Items\\{folder}{name}.Item.Gbx")

OUT.write_text("\n".join(sorted(paths)), encoding="utf-8")
shutil.copyfile(OUT, PLUGIN)
print(f"{len(missing_blocks)} blocks + {len(missing_items)} items without geometry")
print(f"{len(paths)} candidate paths -> {OUT}")
print(f"copied to {PLUGIN}")
