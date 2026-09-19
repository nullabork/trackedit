#!/usr/bin/env python3
"""Build a Trackmania texture mod that replaces the SKY.

A map can reference a texture mod (a zip). Its `Moods/<Mood>/` folder mirrors
the game's `Stadium/Media/Moods/<Mood>/`:

  SkyColor.dds   1024x512 equirectangular HDR panorama of the sky (BC6H)
  SkyClouds.dds  the cloud layer (DXT5, alpha = coverage)
  Mood.MoodSetting.xml  sun/ambient colours, time of day, fog, cloud tints

This tool writes `<Trackmania>/Skins/Stadium/Mod/<name>.zip` from a panorama
image (any equirectangular PNG/JPG; top = zenith, middle = horizon) or a
built-in test chart with compass letters, optionally clears the clouds, and
optionally ships an edited mood settings file. DDS headers are copied from the
game's own files (Openplanet extract), so format flags are exactly the game's;
only the pixel data is ours. BC6H is encoded here (mode 11: one region, 10-bit
endpoints) — no external tools.

  python tools/sky_mod.py --name TrackeditSkyTest --chart
  python tools/sky_mod.py --name MySky --panorama sky.jpg --exposure 2 --clouds clear
  python tools/sky_mod.py --name GreenSun --chart --mood-xml edited.xml

Point a map at it with:
  meshdump atmosphere in.Map.Gbx out.Map.Gbx mod=Skins\\Stadium\\Mod\\<name>.zip
"""
import argparse, json, os, struct, sys, zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont

MOODS = ["Day", "Sunset", "Night", "Sunrise"]
WEIGHTS4 = np.array([0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64], dtype=np.int64)


def local_cfg():
    try:
        return json.load(open(os.path.join(os.path.dirname(__file__), "..", ".trackedit.local.json"), encoding="utf-8"))
    except Exception:
        return {}


def game_moods_dir():
    op = local_cfg().get("openplanetDir") or os.path.expandvars(r"%USERPROFILE%\OpenplanetNext")
    return os.path.join(op, "Extract", "GameData", "Stadium", "Media", "Moods")


def trackmania_dir():
    cfg = local_cfg().get("trackmaniaDir")
    home = os.path.expanduser("~")
    for c in [cfg, os.path.join(home, "Documents", "Trackmania"), os.path.join(home, "OneDrive", "Documents", "Trackmania")]:
        if c and os.path.isdir(os.path.join(c, "Skins")):
            return c
    raise SystemExit("Trackmania's Documents folder not found (set trackmaniaDir in .trackedit.local.json)")


# ---------------------------------------------------------------- BC6H (UF16, mode 11)

def _unquantize10(c):
    """10-bit endpoint -> 16-bit interpolation space (BC6H unsigned)."""
    c = c.astype(np.int64)
    out = ((c << 16) + 0x8000) >> 10
    out[c == 0] = 0
    out[c == 1023] = 0xFFFF
    return out


def encode_bc6h(rgb_linear):
    """rgb_linear: float32 (H, W, 3), linear HDR. Returns BC6H_UF16 bytes (mode 11 blocks)."""
    h, w, _ = rgb_linear.shape
    ph, pw = (h + 3) // 4 * 4, (w + 3) // 4 * 4
    img = np.pad(rgb_linear, ((0, ph - h), (0, pw - w), (0, 0)), mode="edge")
    # Target: half-float BIT PATTERNS (positive halves are monotonic as integers).
    half = np.clip(img, 0, 65000).astype(np.float16).view(np.uint16).astype(np.int64)
    # The decoder ends with out = (v * 31) >> 6, so work in v-space.
    target = (half * 64 + 30) // 31
    blocks = target.reshape(ph // 4, 4, pw // 4, 4, 3).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 3)
    n = blocks.shape[0]
    lum = blocks.sum(axis=2)
    lo = blocks[np.arange(n), lum.argmin(axis=1)]
    hi = blocks[np.arange(n), lum.argmax(axis=1)]
    e0 = np.clip((lo + 32) >> 6, 0, 1023)
    e1 = np.clip((hi + 32) >> 6, 0, 1023)
    u0, u1 = _unquantize10(e0), _unquantize10(e1)
    out = bytearray(n * 16)
    step = 8192
    for s in range(0, n, step):
        a, b = u0[s:s + step, None, :], u1[s:s + step, None, :]
        wts = WEIGHTS4[None, :, None]
        palette = (a * (64 - wts) + b * wts + 32) >> 6                       # (m, 16, 3)
        diff = blocks[s:s + step, :, None, :].astype(np.float32) - palette[:, None, :, :].astype(np.float32)
        idx = (diff * diff).sum(axis=3).argmin(axis=2)                      # (m, 16)
        for k in range(idx.shape[0]):
            i = s + k
            ea, eb, ix = e0[i], e1[i], idx[k]
            if ix[0] >= 8:  # the anchor index stores 3 bits: its MSB must be 0
                ea, eb, ix = eb, ea, 15 - ix
            bits = 0x03
            pos = 5
            for v in (ea[0], ea[1], ea[2], eb[0], eb[1], eb[2]):
                bits |= int(v) << pos
                pos += 10
            bits |= int(ix[0]) << pos
            pos += 3
            for j in range(1, 16):
                bits |= int(ix[j]) << pos
                pos += 4
            out[i * 16:i * 16 + 16] = bits.to_bytes(16, "little")
    return bytes(out)


def mip_chain(img, levels):
    """Box-filtered mips of a float image, `levels` long (top included)."""
    out = [img]
    cur = img
    for _ in range(levels - 1):
        h, w, c = cur.shape
        nh, nw = max(h // 2, 1), max(w // 2, 1)
        cur = cur[: nh * 2 if h > 1 else 1, : nw * 2 if w > 1 else 1]
        if h > 1:
            cur = (cur[0::2] + cur[1::2]) / 2
        if w > 1:
            cur = (cur[:, 0::2] + cur[:, 1::2]) / 2
        out.append(cur)
    return out


def read_dds_header(path):
    d = open(path, "rb").read(148)
    assert d[:4] == b"DDS ", path
    dx10 = d[84:88] == b"DX10"
    size = 148 if dx10 else 128
    height, width = struct.unpack_from("<II", d, 12)
    mips = max(struct.unpack_from("<I", d, 28)[0], 1)
    return d[:size], width, height, mips, d[84:88], (struct.unpack_from("<I", d, 128)[0] if dx10 else None)


def sky_color_dds(panorama_linear, template_path):
    header, w, h, mips, fourcc, dxgi = read_dds_header(template_path)
    if not (fourcc == b"DX10" and dxgi == 95):
        raise SystemExit(f"{template_path}: expected BC6H_UF16 (DX10/95), found {fourcc} {dxgi}")
    img = np.asarray(Image.fromarray((np.clip(panorama_linear / panorama_linear.max(), 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS), dtype=np.float32) / 255 * panorama_linear.max() \
        if panorama_linear.shape[:2] != (h, w) else panorama_linear
    data = b"".join(encode_bc6h(m.astype(np.float32)) for m in mip_chain(img, mips))
    return header + data


def clear_clouds_dds(template_path):
    header, w, h, mips, fourcc, _ = read_dds_header(template_path)
    if fourcc != b"DXT5":
        raise SystemExit(f"{template_path}: expected DXT5, found {fourcc}")
    # An all-zero DXT5 block is transparent black.
    blocks = sum(max((w >> i) + 3 >> 2, 1) * max((h >> i) + 3 >> 2, 1) for i in range(mips))
    return header + bytes(blocks * 16)


# ---------------------------------------------------------------- panoramas

def srgb_to_linear(a):
    a = a.astype(np.float32) / 255
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def chart(w=1024, h=512):
    """A sky you cannot mistake for the game's: magenta zenith to orange horizon,
    compass letters at the horizon, elevation rings every 15 degrees."""
    y = np.linspace(0, 1, h)[:, None]
    top, mid, low = np.array([150, 0, 170]), np.array([255, 140, 20]), np.array([20, 40, 60])
    sky = np.where(y < 0.5, top * (1 - y * 2) + mid * (y * 2), low * np.ones_like(y))
    im = Image.fromarray(np.broadcast_to(sky[:, None, :], (h, w, 3)).astype(np.uint8).copy())
    d = ImageDraw.Draw(im)
    fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    try:
        font = ImageFont.truetype(os.path.join(fonts, "arialbd.ttf"), 56)
        small = ImageFont.truetype(os.path.join(fonts, "arial.ttf"), 20)
    except Exception:
        font = small = ImageFont.load_default()
    for deg in range(15, 90, 15):
        yy = int(h / 2 - deg / 90 * h / 2)
        d.line([(0, yy), (w, yy)], fill=(255, 255, 255), width=1)
        d.text((6, yy - 22), f"{deg}", fill=(255, 255, 255), font=small)
    d.line([(0, h // 2), (w, h // 2)], fill=(255, 255, 0), width=3)
    for i, label in enumerate(["0", "90", "180", "270"]):
        x = int(i * w / 4)
        d.line([(x, 0), (x, h // 2)], fill=(255, 255, 255), width=2)
        d.text((x + 10, h // 2 - 90), label, fill=(255, 255, 255), font=font)
    return np.asarray(im)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="mod name -> Skins/Stadium/Mod/<name>.zip")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--panorama", help="equirectangular image (top = zenith)")
    src.add_argument("--chart", action="store_true", help="built-in test chart")
    ap.add_argument("--exposure", type=float, default=2.0, help="HDR scale applied to the linear image (default 2)")
    ap.add_argument("--clouds", choices=["keep", "clear"], default="keep")
    ap.add_argument("--mood-xml", help="edited Mood.MoodSetting.xml to ship for every mood")
    ap.add_argument("--moods", nargs="*", default=MOODS)
    ap.add_argument("--out", help="output zip (default: the game's Skins/Stadium/Mod folder)")
    args = ap.parse_args()

    pixels = chart() if args.chart else np.asarray(Image.open(args.panorama).convert("RGB"))
    linear = srgb_to_linear(pixels) * args.exposure
    moods_dir = game_moods_dir()
    out = args.out or os.path.join(trackmania_dir(), "Skins", "Stadium", "Mod", args.name + ".zip")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for mood in args.moods:
            sky = sky_color_dds(linear, os.path.join(moods_dir, mood, "SkyColor.dds"))
            z.writestr(f"Moods/{mood}/SkyColor.dds", sky)
            if args.clouds == "clear":
                z.writestr(f"Moods/{mood}/SkyClouds.dds", clear_clouds_dds(os.path.join(moods_dir, mood, "SkyClouds.dds")))
            if args.mood_xml:
                z.write(args.mood_xml, f"Moods/{mood}/Mood.MoodSetting.xml")
    print(f"wrote {out} ({os.path.getsize(out)} bytes): moods {', '.join(args.moods)}, clouds {args.clouds}" +
          (", mood settings included" if args.mood_xml else ""))
    print("map reference: Skins\\Stadium\\Mod\\" + args.name + ".zip")


if __name__ == "__main__":
    main()
