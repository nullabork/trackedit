"""Developer tool: (re)write the hue-mask PNGs with their ALPHA, the channel that says
which texels a block's paint touches.

The game's `<Texture>_D_HueMask.dds` files are DXT5 strips or planes whose RGB is a
near-constant green and whose ALPHA is the mask: on RoadTech the asphalt rows are 0 and
the border lights 255; on RoadDirt the dirt is 0; on Structure and TechnicsTrims it is
255 throughout. meshdump used to flatten alpha to 255 and read the green channel, which
painted the asphalt and the dirt along with everything else (NOTES 5p/5q). meshdump now
keeps alpha; this script does the same conversion in Python for an existing import, so
the masks on disk can be fixed without a 40-minute re-import, and prints what each mask
holds. Decodes DXT1/DXT5 (vectorised) and TGA.

usage: python tools/hue_masks.py [--root <GameData/Stadium>] [--meshes public/meshes] [--stats]
       (npm run huemasks)
"""
import argparse
import json
import os
import struct
import sys

import numpy as np
from PIL import Image


def decode_dds(path):
    b = open(path, "rb").read()
    h, w = struct.unpack_from("<II", b, 12)
    fourcc = b[84:88]
    off = 128
    if fourcc == b"DX10":
        fmt = struct.unpack_from("<I", b, 128)[0]
        fourcc = {71: b"DXT1", 77: b"DXT5"}.get(fmt, fourcc)
        off = 148
    bw, bh = (w + 3) // 4, (h + 3) // 4
    n = bw * bh
    if fourcc == b"DXT5":
        blocks = np.frombuffer(b, dtype=np.uint8, count=n * 16, offset=off).reshape(n, 16)
        a0 = blocks[:, 0].astype(np.int32)
        a1 = blocks[:, 1].astype(np.int32)
        bits = np.zeros(n, dtype=np.uint64)
        for k in range(6):
            bits |= blocks[:, 2 + k].astype(np.uint64) << np.uint64(8 * k)
        pal = np.zeros((n, 8), dtype=np.int32)
        pal[:, 0], pal[:, 1] = a0, a1
        big = a0 > a1
        for i in range(2, 8):
            pal[:, i] = np.where(big, ((8 - i) * a0 + (i - 1) * a1) // 7,
                                 np.where(i < 6, ((6 - i) * a0 + (i - 1) * a1) // 5, np.where(i == 6, 0, 255)))
        alpha = np.zeros((n, 16), dtype=np.uint8)
        for i in range(16):
            idx = ((bits >> np.uint64(3 * i)) & np.uint64(7)).astype(np.int64)
            alpha[:, i] = pal[np.arange(n), idx]
        colour = blocks[:, 8:16]
    elif fourcc == b"DXT1":
        colour = np.frombuffer(b, dtype=np.uint8, count=n * 8, offset=off).reshape(n, 8)
        alpha = np.full((n, 16), 255, dtype=np.uint8)
    else:
        raise ValueError(f"unsupported DDS {fourcc!r}")
    c0 = colour[:, 0].astype(np.int32) | (colour[:, 1].astype(np.int32) << 8)
    c1 = colour[:, 2].astype(np.int32) | (colour[:, 3].astype(np.int32) << 8)

    def rgb(v):
        return np.stack([((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31], axis=1)
    p0, p1 = rgb(c0), rgb(c1)
    four = (c0 > c1) | (fourcc == b"DXT5")
    p2 = np.where(four[:, None], (2 * p0 + p1) // 3, (p0 + p1) // 2)
    p3 = np.where(four[:, None], (p0 + 2 * p1) // 3, 0)
    pal = np.stack([p0, p1, p2, p3], axis=1)  # n x 4 x 3
    idx = colour[:, 4].astype(np.uint32) | (colour[:, 5].astype(np.uint32) << 8) | (colour[:, 6].astype(np.uint32) << 16) | (colour[:, 7].astype(np.uint32) << 24)
    out = np.zeros((n, 16, 4), dtype=np.uint8)
    for i in range(16):
        sel = (idx >> (2 * i)) & 3
        out[:, i, :3] = pal[np.arange(n), sel]
    out[:, :, 3] = alpha
    img = out.reshape(bh, bw, 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(bh * 4, bw * 4, 4)
    return img[:h, :w]


def load_mask(path):
    if path.lower().endswith(".tga"):
        return np.asarray(Image.open(path).convert("RGBA"))
    return decode_dds(path)


def find_mask(root, source):
    base = os.path.join(root, source.replace("\\", "/"))
    stem, _ = os.path.splitext(base)
    for ext in (".dds", ".tga", ".png"):
        p = stem + "_HueMask" + ext
        if os.path.exists(p):
            return p
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.path.expandvars(r"%USERPROFILE%\OpenplanetNext\Extract\GameData\Stadium"))
    ap.add_argument("--meshes", default=os.path.join("public", "meshes"))
    ap.add_argument("--stats", action="store_true", help="print each mask's alpha bands, write nothing")
    a = ap.parse_args()
    mats = json.load(open(os.path.join(a.meshes, "materials.json"), encoding="utf-8"))
    done = {}
    for name, m in sorted(mats.items()):
        if not m.get("hueMask") or not m.get("source"):
            continue
        source = m["source"].split("+")[0]  # decals combine two sources; the mask belongs to the first
        src = find_mask(a.root, source)
        if not src:
            print(f"  {name}: no mask beside {source}")
            continue
        if src in done:
            if not a.stats:
                Image.open(done[src]).save(os.path.join(a.meshes, m["hueMask"]))
            continue
        img = load_mask(src)
        h, w = img.shape[:2]
        al = img[..., 3]
        bands = [int(al[k * h // 4:(k + 1) * h // 4].mean()) for k in range(4)] if h >= 4 else [int(al.mean())]
        print(f"  {name}: {os.path.basename(src)} {w}x{h}  alpha by quarter {bands}  painted {100 * (al > 32).mean():.0f}%")
        if a.stats:
            continue
        im = Image.fromarray(img, "RGBA")
        if w > 512 or h > 512:
            s = 512 / max(w, h)
            im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BILINEAR)
        out = os.path.join(a.meshes, m["hueMask"])
        im.save(out)
        done[src] = out
    print("done" if not a.stats else "")


if __name__ == "__main__":
    sys.exit(main())
