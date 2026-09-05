"""Bake the editor's skyboxes from Poly Haven's CC0 sky HDRIs.

Downloads the tonemapped 8K equirect JPG for one real photographed sky per
mood and downsizes it to public/sky/<Mood>.jpg (2048x1024, ~0.5MB). The
results are committed — this script is provenance + regeneration, users
don't need to run it. All Poly Haven assets are CC0 (polyhaven.com/license).

usage: python tools/fetch_skies.py
"""

import io
import urllib.request
from pathlib import Path

from PIL import Image

# RULES learned picking these:
# - Vet each pick by its TONEMAPPED jpg, not the asset preview — some don't
#   match (kloppenheim_02_puresky's tonemapped is a moonlit night).
# - "puresky" assets only: NO landscape/silhouettes in the skybox. Every
#   photographic night but qwantani has terrain in it.
SKIES = {
    "Day": "kloofendal_48d_partly_cloudy_puresky",
    "Sunrise": "qwantani_dawn_puresky",
    "Sunset": "belfast_sunset_puresky",
    "Night": "qwantani_night_puresky",  # long-exposure starfield + milky way
}
OUT = Path(__file__).resolve().parent.parent / "public" / "sky"
W, H = 2048, 1024

OUT.mkdir(parents=True, exist_ok=True)
for mood, slug in SKIES.items():
    url = f"https://dl.polyhaven.org/file/ph-assets/HDRIs/extra/Tonemapped%20JPG/{slug}.jpg"
    print(f"{mood}: {slug} ...", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "trackedit-skies"})
    data = urllib.request.urlopen(req).read()
    img = Image.open(io.BytesIO(data)).convert("RGB").resize((W, H), Image.LANCZOS)
    img.save(OUT / f"{mood}.jpg", quality=88, optimize=True)
    print(f"  -> {OUT / (mood + '.jpg')} ({(OUT / (mood + '.jpg')).stat().st_size // 1024} KB)")
print("done")
