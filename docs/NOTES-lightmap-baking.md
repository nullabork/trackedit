# Baking shadows ourselves — research log

Goal: custom lighting and shadows for maps saved from trackedit, without
depending on the game's "compute shadows". This log records what the map file
actually stores, the tools we have, and the experiments that decide how far
this can go.

## 1. What a map stores

Computed shadows live in two places of the `.Map.Gbx` (`meshdump
lightmapinfo <map> deep` prints all of it):

**Lightmap frames** (`CGameCtnChallenge.LightmapFrames`, 3 frames). The
images are ordinary **WebP** files:

| image | size (Simple 25) | content |
| --- | --- | --- |
| `frame0_Data` | 1024×1024 | the baked light **colour** atlas: sky-blue ambient, green bounce off grass, black in shadow |
| `frame0_Data2` | 1024×1024 | greyscale, the **directional** part (the cache says `Bump: HBasis_Intens`) |
| `frame0_Data3` | 167×167 | small, probably the light **probe grid** used for cars/dynamic objects (frame 0 also carries `ProbeGridBox` entries) |
| `frame1_Data`, `frame2_Data` | 1024×1024 | further atlases (frame 1 busy, frame 2 nearly empty) — likely more atlas pages or other quality levels |

**Lightmap cache** (`CHmsLightMapCache`, zlib-compressed). Bake settings
(`AmbSample 256`, `DirSamples 64`, `PntSamples 25`, `CompressMode
Scale_sRGB_DXT1`, `AllocMode BestSizePUseFree`, `AllocatedTexelByMeter`), a
`LightmapCacheUid`, the decoration, and the **mapping**: atlas space
2048×2048, the map's bounding box, and one entry per lightmapped object
(2880 on Simple 25) as packed `Int16`/`float` arrays — where each object's
lightmap UVs land in the atlas.

The lightmap is most of a map file: 1.4 of Islander's 1.6 MB.

## 2. Tools

```
meshdump lightmapinfo   <map.Gbx> [deep]          what is stored
meshdump lightmap-extract <map.Gbx> <dir>         frames -> frameN_Data*.png (+ the raw .webp)
meshdump lightmap-inject  <map.Gbx> <dir> <out.Map.Gbx> [lossless] [name=New name]
```

`inject` replaces any frame image for which `<dir>` holds a PNG of the same
name, and with `name=` gives the copy its own map name and uid (so the game
cannot reuse a cached lightmap of the source map).

## 3. Experiment 1 — does the game honour a lightmap it did not bake?

Three copies of Simple 25 (TMX #353760) in `Maps/Trackedit`:

- **LM test C - untouched reencode** — same pixels, re-encoded by us
  (lossless WebP). Control: if this one looks wrong or the game asks to
  recompute shadows, the container or encoding matters, not the pixels.
- **LM test A - sunset grade** — `frame0_Data` recoloured: orange light,
  violet shadows. If the map looks like that in game, **edited lightmaps
  work**, which already gives custom lighting by grading or painting the
  game's own bake.
- **LM test B - texel chart** — `frame0_Data` replaced by a coordinate chart
  (red = u, green = v, white grid every 64 px). In game this shows which atlas
  texel lands on which surface: the ground truth for decoding the mapping.

What to look for: open each in the editor or play it. Note whether the game
says shadows need computing, and what the surfaces look like.

Outcomes:

- A and B show our pixels → go to section 4.
- C fine, A/B ignored or recomputed → the game checks the images against
  something (the cache uid or a hash); find it before anything else.
- C already broken → fix the encode (lossy vs lossless, alpha, size) first.

### Result (2026-09-19): it works

Tested in game by the map owner. **A shows the sunset grade, B shows the
texel chart** on the terrain and blocks, and the game did not ask to
recompute shadows. The game honours lightmap pixels it did not bake, with
the mapping and cache uid left as they were. Only the skybox keeps the
map's own mood, since the sky is not lit by the lightmap.

In B the stadium grass shows large rectangles of differing red/green mix
with the white 64 px grid at very different scales per rectangle: each
terrain patch owns its own atlas rect, at its own texel density.

## 4. If edited lightmaps work: the road to a baker

1. **Grade/paint the game's bake.** Works today with extract → edit → inject.
   Custom light colour, stylised shadows, time-of-day looks. Geometry must be
   unchanged since the game's bake.
2. **Decode the mapping.** With the texel chart in game plus the mapping
   arrays, work out object order and rect layout; confirm by predicting where
   a given block's texels are.
3. **Rebake existing layouts.** Keep the game's mapping, recompute only the
   pixels (our own sun, sky, bounce, extra lights) by ray tracing the scene
   we already render. Needs the blocks' lightmap UV channel from the meshes.
4. **Bake from scratch.** Produce mapping + frames for a map the game never
   baked (what trackedit saves). Needs the allocator's rules only as far as
   the game accepts any consistent mapping — which experiment 3 would tell.

Each step is checkable in game before the next one starts.

## 5. Wanted: a sun and moon you can place (logged 2026-09-19, not started)

Once we bake the pixels ourselves (step 3 above), lighting becomes an
editor feature rather than a fixed mood:

- A **Move sun tool**. Arming it shows a giant sphere around the map; the
  sun sits on it and you drag it anywhere in the sky. Its position on the
  sphere is the light direction the bake uses.
- A **moon on the opposite side** of the sphere, always antipodal to the sun,
  so moving one moves the other.
- **Sun colour** and **moon colour**, each its own picker.
- A point light is the same idea with a position instead of a direction;
  the cache already has a `PntSamples` setting, so the game's own bakes
  support point lights.

Notes for when we build it:

- Store it per map (sun direction as azimuth/elevation, two colours, maybe
  intensities) next to mood and palette, and persist it in the map record.
- The viewport should preview it live: drive the scene's directional light
  and shadow from the same values, so what you drag is what gets baked.
- The bake then uses sun + moon as the two directional lights and the sky
  colour as ambient. The greyscale directional atlas (`frame0_Data2`) will
  have to be regenerated to match the new sun direction, or surfaces with
  normal maps will still shade as if lit from the old one.
- Depends on experiment 1 passing (section 3) and the mapping being decoded.

## 6. The sky (logged 2026-09-19, not started)

The lightmap does not light the sky, so a graded map keeps its mood's
skybox. What the map format offers, cheapest first:

1. **Mood.** The decoration id carries it (`48x48Screen155Day` / `Sunset` /
   `Night` / `Sunrise`), which sets sky, sun and clouds. `meshdump build`
   currently keeps the template's decoration; writing the editor's mood is a
   small change. Open question: the lightmap cache names its decoration, so
   a mood switch may make the game want a rebake — test before relying on it.
2. **A MediaTracker in-game clip as a filter.** A map can carry a clip that
   plays for the whole race. GBX.NET exposes the relevant blocks:
   - `Fog` keys: `Color`, `Intensity`, **`SkyIntensity`**, `Distance`,
     `Coefficient`, `CloudsOpacity`, `CloudsSpeed` — tints the sky towards a
     colour and can fade the clouds out. This is the "custom sky colour".
   - `ColorGrading`: a LUT image + intensity — a filter over everything,
     sky included (the image has to ship with the map or exist on the
     player's side).
   - `ToneMapping` (exposure), `BloomHdr`, `FxColors` (saturation,
     contrast, brightness, near and far).
   RPG mappers use exactly this for atmosphere, so it is a supported path.
3. **A real custom skybox** is not something the map format offers: the sky
   is procedural per mood, not a texture a map can replace.

Natural fit with the sun/moon tool (section 5): sun colour and position
drive the bake, fog colour and sky intensity drive the sky, and both are
stored per map.
