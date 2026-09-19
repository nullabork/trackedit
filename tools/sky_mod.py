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
import argparse, json, math, os, re, struct, sys, zipfile
import numpy as np
from PIL import Image, ImageDraw

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


# Where the game shows each row of SkyColor.dds, measured in game
# (docs/NOTES-lightmap-baking.md, section 8): image latitude against real
# height, in degrees. The horizon is below the image's middle row and the
# rows near it are compressed. The bottom end is a guess (never visible).
IMAGE_LATITUDE = [-90, -7.5, -1, 22, 37, 50, 66, 83, 90]
REAL_HEIGHT = [-64, 0, 5, 20, 30, 45, 60, 75, 90]


def true_horizon(pixels, rows=512):
    """Re-row a plain panorama (top = straight up, middle = horizon) so the game shows every row at its real height."""
    src = np.asarray(Image.fromarray(pixels).resize((1024, 2048), Image.LANCZOS))
    latitude = 90 - (np.arange(rows) + 0.5) / rows * 180
    real = np.interp(latitude, IMAGE_LATITUDE, REAL_HEIGHT)
    pick = np.clip(((90 - real) / 180 * src.shape[0]).astype(int), 0, src.shape[0] - 1)
    return src[pick]


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


def dark_chart(w=1024, h=512):
    """A near-black sky with a dim grid: the game's own sun and its glow stay
    visible against it, so their heading and height can be read. Same marks
    as chart(): 1-4 squares per quarter turn, rings every 15 degrees of image
    latitude (the 45 ring is thickest, 30 and 60 medium), horizon line dim yellow.
    The lower half carries the same grid mirrored in blue, to show how far
    below the image's middle the visible sky reaches."""
    im = Image.new("RGB", (w, h), (3, 4, 8))
    d = ImageDraw.Draw(im)
    for half, color in ((-1, (70, 70, 70)), (1, (30, 50, 90))):
        for deg in range(15, 90, 15):
            yy = int(h / 2 + half * deg / 90 * h / 2)
            d.line([(0, yy), (w, yy)], fill=color, width={45: 4, 30: 2, 60: 2}.get(deg, 1))
    d.line([(0, h // 2), (w, h // 2)], fill=(110, 110, 0), width=3)
    for i in range(4):
        x = int(i * w / 4)
        d.line([(x, 0), (x, h)], fill=(70, 70, 70), width=2)
        for k in range(i + 1):
            d.rectangle([x + 12 + k * 30, h // 2 - 46, x + 12 + k * 30 + 20, h // 2 - 16], fill=(120, 120, 120))
    return np.asarray(im)


# 3x5 bitmap digits (Pillow's text layout is unreliable on some installs).
DIGITS = {
    "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
    "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001",
    "8": "111101111101111", "9": "111101111001111",
}


def draw_number(d, x, y, text, scale, fill):
    for ch in text:
        bits = DIGITS[ch]
        for i, bit in enumerate(bits):
            if bit == "1":
                cx, cy = x + (i % 3) * scale, y + (i // 3) * scale
                d.rectangle([cx, cy, cx + scale - 1, cy + scale - 1], fill=fill)
        x += 4 * scale


def grid_chart(w=1024, h=512, cols=16, rows=12, tag=None):
    """A near-black sky cut into numbered cells, so a position can be reported
    as one number — and so that any screenshot explains itself:

    - the big number is the cell. Cell n sits at column n % 16 (the image's
      left edge = column 0) and row n // 16 (row 0 = the top; 15 degrees of
      image latitude per row). Rows 0-5 are grey, rows 6-11 blue.
    - the ORANGE CORNER is at the cell's top RIGHT in the normal copy of the
      sky and at its top LEFT in the mirrored copy (the game mirrors the image
      for the other half of the sky; symmetric numbers like 88 or 101 would
      not tell otherwise).
    - the small YELLOW number bottom-left is `tag`, identifying which test
      mod (and so which map) the screenshot came from."""
    im = Image.new("RGB", (w, h), (3, 4, 8))
    d = ImageDraw.Draw(im)
    cw, ch = w / cols, h / rows
    for r in range(rows):
        for c in range(cols):
            x0, y0, x1 = int(c * cw), int(r * ch), int((c + 1) * cw) - 1
            color = (150, 150, 150) if r < rows // 2 else (70, 110, 190)
            d.rectangle([x0, y0, x1, int((r + 1) * ch) - 1], outline=(60, 60, 60))
            draw_number(d, x0 + 6, y0 + 5, str(r * cols + c), 4, color)
            d.polygon([(x1 - 12, y0 + 1), (x1 - 1, y0 + 1), (x1 - 1, y0 + 12)], fill=(230, 110, 0))
            if tag is not None:
                draw_number(d, x0 + 6, y0 + 26, str(tag), 3, (200, 190, 0))
    d.line([(0, h // 2), (w, h // 2)], fill=(130, 130, 0), width=3)
    return np.asarray(im)


def chart(w=1024, h=512):
    """A sky you cannot mistake for the game's: magenta zenith to orange horizon,
    counted heading marks at the horizon, elevation rings every 15 degrees."""
    y = np.linspace(0, 1, h)[:, None]
    top, mid, low = np.array([150, 0, 170]), np.array([255, 140, 20]), np.array([20, 40, 60])
    sky = np.where(y < 0.5, top * (1 - y * 2) + mid * (y * 2), low * np.ones_like(y))
    im = Image.fromarray(np.broadcast_to(sky[:, None, :], (h, w, 3)).astype(np.uint8).copy())
    d = ImageDraw.Draw(im)
    # No text: Pillow's font layout is unreliable on some installs (glyphs
    # came out as empty boxes in game). Headings are COUNTED squares instead:
    # 1 square = 0 deg (left edge of the image), 2 = 90, 3 = 180, 4 = 270;
    # elevation rings every 15 deg, thicker at 45.
    for deg in range(15, 90, 15):
        yy = int(h / 2 - deg / 90 * h / 2)
        d.line([(0, yy), (w, yy)], fill=(255, 255, 255), width=3 if deg == 45 else 1)
    d.line([(0, h // 2), (w, h // 2)], fill=(255, 255, 0), width=3)
    for i in range(4):
        x = int(i * w / 4)
        d.line([(x, 0), (x, h // 2)], fill=(255, 255, 255), width=2)
        for k in range(i + 1):
            d.rectangle([x + 12 + k * 34, h // 2 - 60, x + 12 + k * 34 + 24, h // 2 - 20], fill=(255, 255, 255))
    return np.asarray(im)


# ---------------------------------------------------------------- the sun
#
# Measured in game (docs/NOTES-lightmap-baking.md, section 8): the sun runs
# along a great circle. It rises due East (the game's East, -X) at DayTime01
# 0.5, sets due West at 0.75 (720 degrees of arc per unit), and Latitude
# tilts the circle away from the zenith: towards South (-Z) when positive,
# North when negative. So any point of the sky above the horizon is one
# (DayTime01, Latitude) pair.

SUNRISE01, SUNSET01 = 0.5, 0.75


def sun_position(daytime01, latitude):
    """(azimuth, altitude) in degrees. Azimuth turns from East towards South."""
    t = math.radians((daytime01 - SUNRISE01) / (SUNSET01 - SUNRISE01) * 180)
    lat = math.radians(latitude)
    e, s, u = math.cos(t), math.sin(t) * math.sin(lat), math.sin(t) * math.cos(lat)
    return math.degrees(math.atan2(s, e)), math.degrees(math.asin(max(-1, min(1, u))))


def solve_sun(azimuth, altitude):
    """(DayTime01, Latitude) that put the sun at azimuth/altitude (degrees)."""
    az, alt = math.radians(azimuth), math.radians(altitude)
    e, s, u = math.cos(alt) * math.cos(az), math.cos(alt) * math.sin(az), math.sin(alt)
    t = math.degrees(math.acos(max(-1, min(1, e))))
    return SUNRISE01 + t / 180 * (SUNSET01 - SUNRISE01), math.degrees(math.atan2(s, u))


def mood_xml_with_sun(path, daytime01, latitude):
    """The game's own mood settings with only the sun's two numbers changed."""
    xml = open(path, encoding="utf-8").read()
    for key, value in (("DayTime01", daytime01), ("Latitude", latitude)):
        if value is None:
            continue
        xml, n = re.subn(r'(<Light [^>]*?[ ]%s=")[^"]*(")' % key, lambda m: m.group(1) + ("%.6g" % value) + m.group(2), xml, count=1)
        if n != 1:
            raise SystemExit(f"{path}: no {key} on <Light>")
    return xml


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="mod name -> Skins/Stadium/Mod/<name>.zip")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--panorama", help="equirectangular image (top = zenith)")
    src.add_argument("--chart", action="store_true", help="built-in test chart (bright)")
    src.add_argument("--grid-chart", action="store_true", help="near-black sky cut into numbered cells (report a position as one number)")
    src.add_argument("--dark-chart", action="store_true", help="near-black test chart: the game's sun stays visible against it")
    ap.add_argument("--tag", type=int, help="grid chart only: a small id drawn in every cell, to tell test mods apart in screenshots")
    ap.add_argument("--exposure", type=float, default=2.0, help="HDR scale applied to the linear image (default 2)")
    ap.add_argument("--clouds", choices=["keep", "clear"], default="keep")
    ap.add_argument("--mood-xml", help="edited Mood.MoodSetting.xml to ship for every mood")
    ap.add_argument("--sun", help="AZIMUTH,ALTITUDE in degrees: put the sun there (azimuth from East towards South, negative = towards North); solves DayTime01 and Latitude")
    ap.add_argument("--daytime01", type=float, help="DayTime01 for the mood settings (0.5 sunrise, 0.625 noon, 0.75 sunset)")
    ap.add_argument("--latitude", type=float, help="Latitude for the mood settings")
    ap.add_argument("--moods", nargs="*", default=MOODS)
    ap.add_argument("--out", help="output zip (default: the game's Skins/Stadium/Mod folder)")
    ap.add_argument("--append", action="store_true", help="add to an existing zip (e.g. one `meshdump moodmod` wrote) instead of replacing it")
    ap.add_argument("--raw-rows", action="store_true", help="panorama only: use the image's rows as they are instead of moving them to their real height")
    args = ap.parse_args()

    daytime01, latitude = args.daytime01, args.latitude
    if args.sun:
        az, alt = (float(v) for v in args.sun.split(","))
        if alt <= 0:
            raise SystemExit("--sun: the altitude has to be above the horizon")
        daytime01, latitude = solve_sun(az, alt)
        print("sun at azimuth %g, altitude %g -> DayTime01 %.5f, Latitude %.3f" % (az, alt, daytime01, latitude))
    if (daytime01 is not None or latitude is not None) and args.mood_xml:
        raise SystemExit("--mood-xml already carries the sun; drop it or --sun/--daytime01/--latitude")

    pixels = chart() if args.chart else grid_chart(tag=args.tag) if args.grid_chart else dark_chart() if args.dark_chart else np.asarray(Image.open(args.panorama).convert("RGB"))
    if args.panorama and not args.raw_rows:
        pixels = true_horizon(pixels)
    linear = srgb_to_linear(pixels) * args.exposure
    moods_dir = game_moods_dir()
    out = args.out or os.path.join(trackmania_dir(), "Skins", "Stadium", "Mod", args.name + ".zip")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "a" if args.append and os.path.exists(out) else "w", zipfile.ZIP_DEFLATED) as z:
        for mood in args.moods:
            sky = sky_color_dds(linear, os.path.join(moods_dir, mood, "SkyColor.dds"))
            z.writestr(f"Moods/{mood}/SkyColor.dds", sky)
            if args.clouds == "clear":
                z.writestr(f"Moods/{mood}/SkyClouds.dds", clear_clouds_dds(os.path.join(moods_dir, mood, "SkyClouds.dds")))
            if args.mood_xml:
                z.write(args.mood_xml, f"Moods/{mood}/Mood.MoodSetting.xml")
            elif daytime01 is not None or latitude is not None:
                z.writestr(f"Moods/{mood}/Mood.MoodSetting.xml", mood_xml_with_sun(os.path.join(moods_dir, mood, "Mood.MoodSetting.xml"), daytime01, latitude))
    print(f"wrote {out} ({os.path.getsize(out)} bytes): moods {', '.join(args.moods)}, clouds {args.clouds}" +
          (", mood settings included" if args.mood_xml or daytime01 is not None or latitude is not None else ""))
    print("map reference: Skins\\Stadium\\Mod\\" + args.name + ".zip")


if __name__ == "__main__":
    main()
