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
3. **A real custom skybox: a texture mod.** Correction after research: the
   sky IS replaceable. A map can reference a texture mod (a zip at a URL,
   `ModPackDesc`; players download it on load — see
   [doc.trackmania.com](https://doc.trackmania.com/create/texture-mods/mods/)),
   and the mod's `Moods/` folder holds "ambience textures, like the skybox".
   The game's own files (`GameData/Stadium/Media/Moods/<Mood>/`) show what
   there is to replace:
   - `SkyColor.dds` — a 1024×512 **equirectangular panorama of the sky**.
     Replace it and the sky is any image you like.
   - `SkyClouds.dds`, `Clouds.tga`, `Moon.tga` — cloud layer and moon sprite.
   - `AmbCube.dds`, `EnvCubicHdr.dds` — ambient and reflection cubes (what
     shiny surfaces and cars reflect); should match the new sky.
   - `Mood.MoodSetting.xml` — sun colour (`LDirSun HdrColor`), ambient, moon,
     time of day (`DayTime01`, latitude → **sun position**), atmosphere
     colours, fog colour and range, cloud tints, lightmap bounce factors.
     If the game reads this file from a mod too, it is the native version of
     the sun/moon tool in section 5 — **untested, the next thing to try**.
   The editor already downloads and applies mods, so writing the mod URL
   into a saved map and generating a small mod zip are both in reach.
4. **Far-out custom geometry** (a giant dome item around the map) is the
   other trick mappers use. In TM2020 custom items can only use the game's
   material library, so a dome with its own picture still needs a texture
   mod for that picture — at which point route 3 is simpler and also fixes
   reflections. A dome with stock materials (plain colour, glow, stars made
   of geometry) works with no mod at all. Not researched further.

### Experiment 2 (2026-09-19): mood and fog, in `Maps/Trackedit`

`meshdump atmosphere <in> <out> [mood=…] [fog=r,g,b sky= intensity=
distance= clouds= groupDonor=<map> fogDonor=<map>] [name=…]` writes these.
MediaTracker nodes are cloned from donor maps (an in-game clip group from
one, a Fog block from another), so every chunk version is the game's own.
All three carry test A's sunset-graded lightmap:

- **LM test D - sunset mood** — mood switched Day → Sunset, nothing else.
  Question: does the game keep our lightmap, or demand a rebake because the
  cache says it was baked for Day?
- **LM test E - orange fog sky** — Day mood plus an in-game clip with a Fog
  block (orange, sky intensity 0.8), triggered on the start block and kept
  playing. Question: does the sky turn orange for the whole run?
- **LM test F - sunset mood + fog** — both, fog gentler (sky 0.6,
  intensity 0.6).

`meshdump mediainfo <map>` lists a map's clips, tracks, blocks and fog keys.

Natural fit with the sun/moon tool (section 5): sun colour and position
drive the bake, fog colour and sky intensity drive the sky, and both are
stored per map.

### Result of experiment 2 (2026-09-19): all three work

D, E and F all look right when played, and the game did not ask to recompute
shadows: **a mood switch keeps our lightmap, and an in-game fog clip tints
the sky for the run.** (Played only; not opened in the editor.)

## 7. Experiment 3 — a sky from a texture mod (in `Maps/Trackedit`)

`tools/sky_mod.py` builds a mod zip into `Skins/Stadium/Mod/`: a panorama
(or its built-in test chart) becomes `Moods/<Mood>/SkyColor.dds` for every
mood. Facts it relies on, read from the game's extracted files:

- `SkyColor.dds` is 1024×512, **BC6H_UF16** (HDR), 11 mips. The tool encodes
  BC6H itself (mode 11: one region, 10-bit endpoints, 4-bit indices) and
  copies the DDS header from the game's file, so only pixel data differs —
  the output is byte-for-byte the game file's size. Verified by decoding it
  back with Pillow.
- `SkyClouds.dds` is DXT5; an all-zero DXT5 block is transparent, which is
  how `--clouds clear` removes the cloud layer.
- A map references a local mod as `Skins\Stadium\Mod\<name>.zip`
  (`meshdump atmosphere … mod=…`, optional `modUrl=` for a hosted copy).

Test maps (Simple 25 with the game's own lightmap):

- **Sky test G - chart sky** — magenta-to-orange sky with elevation rings and
  0/90/180/270 labels at the horizon. Shows whether the mod's sky loads, which
  way the panorama faces, and how clouds sit over it.
- **Sky test H - chart sky no clouds** — same with the cloud layer cleared.
- **Sky test I - green sun settings** — also ships an edited
  `Mood.MoodSetting.xml` (green sun and ambient, green atmosphere, earlier
  time of day). If the car or sky turns green, **the game reads mood
  settings from a mod**, which makes sun colour and position native features.

Unknowns this settles: whether the zip layout is `Moods/<Mood>/…`, whether
the game accepts our BC6H, and whether settings files are honoured. If G
shows the normal sky, check the game's log and try the ModWork folder
(`Skins/Stadium/ModWork/Moods/<Mood>/`) with the same files.

### Result of experiment 3 (2026-09-19): all three work

Screenshots from the game:

- **G** — the chart is the sky. The zip layout `Moods/<Mood>/SkyColor.dds`
  is right and the game accepts our BC6H. The game's clouds draw over it, lit
  white. The lower half of the panorama shows below the horizon line as a
  flat band, so the image really is a full sphere.
- **H** — same sky with no clouds: clearing `SkyClouds.dds` works.
- **I** — **the game reads `Mood.MoodSetting.xml` from a mod.** With a green
  sun/ambient/atmosphere and `DayTime01` moved from 0.6 to 0.30, the clouds
  turn green-tinted, a green glow sits at the horizon where the sun now is,
  and the scene is darker. The baked lightmap on the track does not change,
  as expected: it needs a rebake to follow a new sun.

A close-up of the car on map I confirms it: **the car is lit and reflects
green** (rims, bodywork highlights) while the road under it keeps its baked
grey. Dynamic objects follow the mod's sun at once; static geometry follows
the lightmap, so the two only agree after a rebake with the same sun.

(The heading labels rendered as empty boxes: Pillow's text layout is broken
on this install. The chart now uses counted squares instead of text.)

What this gives us, natively and per map, through one small mod zip:

| want | how |
| --- | --- |
| any sky image | `SkyColor.dds` panorama |
| no clouds / own clouds | `SkyClouds.dds` |
| sun colour, moon colour, ambient | `LDirSun`, `LDirMoon`, `LAmbient` `HdrColor` |
| sun position | `DayTime01` with `Latitude` (the sun moves along its daily arc; a free position on the sphere is not proven yet) |
| atmosphere/horizon glow, fog colour and range, cloud tint | `HdrSun/Atmo*`, `Fog`, `Clouds` |
| static lighting that matches | our own lightmap bake (sections 4–5) |

Caveat for sharing: a local mod path only works on this machine. Other
players need the zip hosted at a URL (`modUrl=`), which the game downloads.

## 8. Experiment 4 — where can the sun go? (in `Maps/Trackedit`)

The sun's picture can be painted into the panorama; what matters is where
the LIGHT comes from (car lighting and shadows now, our bake later). Three
controls exist: `DayTime01` and `Latitude` in a mod's mood settings, and the
map file's own `DayTime` field (`meshdump atmosphere … daytime=HH:MM`; one of
the RPG maps on TMX uses it). The game's moods sit at DayTime01 0.6 (Day),
0.73 (Sunset), 0.15 (Night), 0.52 (Sunrise), all at latitude 45.

All five use the chart sky with clouds cleared, so the sun's glow can be
read against it: **1 / 2 / 3 / 4 white squares mark headings a quarter turn
apart** (1 = the left edge of the panorama), elevation rings every 15°, the
thick ring is 45°, yellow line = horizon.

| map | change | question |
| --- | --- | --- |
| Sun test J25 | DayTime01 0.25 | where is the sun early in the day |
| Sun test J75 | DayTime01 0.75 | and late: does it cross the sky, which way |
| Sun test K0 | noon, latitude 0 | does latitude raise the arc (sun overhead?) |
| Sun test K85 | noon, latitude 85 | and lower it (sun near the horizon?) |
| Sun test L06 | map DayTime 06:00, stock settings | does the map field move the sun without any settings file |

For each: which heading squares the sun/glow is nearest, how many rings up,
and which way the car's shadow falls. Also worth noting from the settings
file: `Fx/ColorGrading FileName` — a per-mood colour grading LUT, i.e. a
native full-screen filter a mod can ship.

### First pass (2026-09-19): the bright chart hides the sun

Only K85 showed the sun: a disc with a glow and lens flare, low near the
real horizon, inside the chart's dark lower band. Findings:

- **The game draws its own sun** (disc, glow, flare) on top of the sky
  panorama, at the position the settings give. A painted sun in the panorama
  would be a second one, so either paint none or hide the game's.
- Against the bright magenta-orange chart the glow washes out, so the other
  maps told nothing. L06 only showed the sky going dark.
- The chart's yellow "horizon" line sits clearly ABOVE the real horizon and
  the sun: the panorama's middle row is not the horizon. The vertical mapping
  of `SkyColor.dds` still has to be measured.

Second pass, replacing the first: `Sun2 …` maps use `--dark-chart` (near-black
sky, dim grid, the same counted heading squares, rings mirrored in blue below
the middle row to measure how far down the visible sky reaches), plus
**Sun2 L00**, a stock-Day baseline. K0 (sun near overhead) and K85 (sun about
5 degrees up) give two known heights to calibrate the rings against.

Third pass (the map owner's idea): **numbered cells**. `--grid-chart` cuts the
near-black sky into 16 x 12 cells, each showing its number (digits are drawn
as 3x5 bitmaps; Pillow's text layout is broken on this install). `Sun3 …`
maps replace `Sun2 …`. Decoding a reported cell `n`:

- column `n % 16`: heading, 22.5 degrees per column, column 0 = the image's
  left edge;
- row `n // 16`: 15 degrees of image latitude per row, row 0 = the top of
  the image. Rows 0-5 (grey numbers, 0-95) are the upper half, rows 6-11
  (blue numbers, 96-191) the lower half; the dim yellow line is the middle.

Wanted per map: the cell the sun is in, the lowest row of numbers visible
at the real horizon, and which cell is straight ahead at the start.

### Readings from the numbered grid (2026-09-19)

Reported by the map owner from `Sun3 …`:

| map | sun | ahead of the car at the start |
| --- | --- | --- |
| L00 stock Day (0.6, lat 45) | on the seam between 32 and mirrored 32 | mirrored 85/86 over 101/102 |
| K85 (0.5, lat 85) | seam 96 / mirrored 96, centre of the cell | same as L00 → sun roughly ahead |
| K0 (0.5, lat 0) | same seam, a little higher | same |
| J25 (0.25) | same seam, bottom corner of the cell | same |
| J75 (0.75) | same seam, on the horizon, **directly behind the car** | 111 and mirrored 111 |
| L06 (map DayTime 06:00) | night, **no grid at all** | — |

What this establishes:

1. **The sky image covers half the sky and is mirrored for the other half.**
   Every number appears twice, once mirrored. So one column is 11.25° of
   heading, not 22.5°, and a custom sky is always left-right symmetric.
2. **The seam is the sun.** The sun always sits where column 0 meets its
   mirror image; column 15 and its mirror (111/111) are the point opposite
   the sun. So **the whole sky dome turns with the sun's heading**, and
   u = angle away from the sun (0..180°). A sun painted at the image's left
   edge will always line up with the real light.
3. **DayTime01 moves the sun's heading a lot.** Relative to the car's start
   direction: 0.5 → ahead, 0.6 → about 67° to the side (the car faces the
   column 5/6 boundary of the mirrored half), 0.75 → directly behind. About
   720° of heading per unit, so the daylight arc runs roughly 0.5 → 0.75,
   not 0.25 → 0.75.
4. **0.5 is sunrise, not noon**, which is why the latitude test told nothing:
   at sunrise the sun is on the horizon at any latitude (K0 and K85 differ by
   a fraction of a cell). The stock moods agree: Sunrise 0.52, Day 0.6,
   Sunset 0.73. Solar noon should be near 0.625.
5. **Vertical mapping.** A sun on the true horizon shows just below the
   image's middle line (in row 6), so the middle row of `SkyColor.dds` is a
   few degrees ABOVE the real horizon, and the image continues below it.
   The stock Day sun (0.6, lat 45) sits at the centre of row 2, i.e. 52.5°
   up in image terms.
6. **The map's own DayTime switches moods.** At 06:00 the game was in its
   night look with the stock sky, because that mod only replaced the Day
   folder. The map field drives a day cycle across the four mood sets
   (`Default.MoodBlender.xml`), so a sky mod has to cover every mood it can
   land on.

### Fourth pass: `Sun4 …` (replaces `Sun3 …`)

| map | change | question |
| --- | --- | --- |
| T55, T70 | DayTime01 0.55 / 0.70 | two more points on the heading and height curve |
| N0, N85 | solar noon (0.625) at latitude 0 / 85 | does latitude set the noon height (overhead vs near the horizon) |
| S45 | solar noon at latitude −45 | does a southern latitude put the sun on the other side |
| D0600, D1200, D1800 | map DayTime, grid sky in ALL four moods | the sun's place through the map-driven day cycle |

If time sets the heading and latitude sets the height, the two together reach
most of the sky, which is what the sun tool needs: pick a point on the
sphere, solve for (DayTime01, Latitude), write them into the map's mod.

### Fifth pass: self-describing cells, `Sun5 …` (replaces `Sun4 …`)

The map owner's idea: a screenshot should say by itself which map it is,
which cell, and whether the copy is mirrored. `--grid-chart --tag N` now
draws in every cell: the big cell number; an **orange corner, top RIGHT in
the normal copy and top LEFT in the mirrored one**; and a small **yellow
id** bottom-left. Same questions as the fourth pass, ids:

| id | map | settings |
| --- | --- | --- |
| 1 | T55 | DayTime01 0.55 |
| 2 | T70 | DayTime01 0.70 |
| 3 | N0 | 0.625, latitude 0 |
| 4 | N85 | 0.625, latitude 85 |
| 5 | S45 | 0.625, latitude −45 |
| 6 / 7 / 8 | D0600 / D1200 / D1800 | map DayTime, grid in all four moods |

Per map two screenshots are enough: one of the sun, one straight ahead of
the car at the start.

### Readings from `Sun5 …` (2026-09-19): the sun follows a plain solar model

Read off the map owner's screenshots (the mirror corner also unmasked a
mirrored id "2" that looks like a "5"). "Ahead" is the cell corner nearest
the screen centre, so headings are good to about half a column (±5.6°).

| id | settings | ahead of the car | sun |
| --- | --- | --- | --- |
| 2 T70 | 0.70, lat 45 | mirrored 93/92 → 146° from the sun | seam 64, upper quarter of row 4 |
| 4 N85 | 0.625, lat 85 | mirrored 88/87 → 90° | seam 96, on the middle line |
| 5 S45 | 0.625, lat −45 | **normal** 87/88 → 90°, other side | seam 32, lower third of row 2 |
| 6 D0600 | map 06:00 | mirrored 84/83 → 45° | night; a glow on seam 64, low in row 4 |
| 7 D1200 | map 12:00 | mirrored 86/85 → 67° | seam 32, middle of row 2 |
| 8 D1800 | map 18:00 | mirrored 94/93 → 157° | seam 64, middle of row 4 |

(1 T55 and 3 N0 were not run.)

1. **Which side.** In the normal copy numbers rise to the right, so the sun
   (column 0) is to the viewer's LEFT; facing the mirrored copy it is to the
   RIGHT. Northern latitudes: sun on the car's right; latitude −45: on its
   left. The test map's start faces the game's East (−X; start x=28, finish
   x=22). So: **sunrise due East (−X), noon due South (−Z) for positive
   latitude, sunset due West (+X)** — the game's own compass.
2. **The model.** A great circle: angle θ = (DayTime01 − 0.5) · 720°, tilted
   from the zenith by the latitude:
   `dir = cosθ·East + sinθ·(cos(lat)·Up + sin(lat)·South)`.
   Predicted headings from East: 0.6 → 65° (read 67), 0.70 → 153° (read 146),
   noon → 90° at any latitude (read 90, both hemispheres). Predicted noon
   heights: lat 85 → 5°, just above where a horizon sun showed (K85/J75,
   centre of row 6) — read: the middle line, half a row higher. Fits.
3. **Inverse.** For a direction (e, s, u) = (East, South, Up parts):
   θ = acos(e), latitude = atan2(s, u). Every point above the horizon is
   reachable with DayTime01 in 0.5..0.75 and a latitude in −90..90; the game
   took 85 and −45 without complaint. `tools/sky_mod.py --sun AZ,ALT` does
   this (also `--daytime01`, `--latitude`), patching the game's own mood
   settings file instead of a hand-edited copy.
4. **The map's DayTime is continuous, not just a mood switch.**
   `GameCtnDecorationMood/Default.MoodBlender.xml` reads `SunRise="06:00"
   SunFall="21:00" Latitude="47.5"`. Mapping 06:00..21:00 linearly onto
   0.5..0.75 gives 12:00 → 0.60 (read: identical to stock Day) and 18:00 →
   0.70 (read: within a column of T70, same row; the Sunset mood's own 0.73
   would put the sun a row lower and nearly behind the car). So map time
   alone can move the sun along the latitude-47.5 arc with no mod at all.
   Night is not understood: at 06:00 the game showed night with a glow 45°
   right of ahead and about 20° up, which is not the sun's circle mirrored.
5. **Vertical mapping of `SkyColor.dds`: about 11.7° of real height per
   chart row, not 15°.** Two independent signs: fitting image latitude
   against the model's heights (0° → −7.5, 5° → −1, 25° → 22..26, 45° → 50)
   gives image ≈ 1.28 · height − 7.5°; and the cells ahead of the car are
   about as tall as wide on screen (300 × 285 px) where a column is 11.25°.
   So the image's middle line is ≈ 6° up, its bottom ≈ −64°, and its top row
   would be reached near 76° — what the dome does above that is unknown.

### Sixth pass: `Sun6 …` — predictions instead of sweeps

Built with `--sun`, which solves the settings from a target. If the model
holds, the sun lands where the file name says (relative to the car at the
start), in the predicted cell:

| id | target (heading from ahead, height) | solved DayTime01 / Latitude | predicted sun cell | predicted ahead |
| --- | --- | --- | --- | --- |
| 1 | 30° right, 30° up | 0.5575 / 40.9 | seam 48, bottom edge of the row | mirrored column 2 (…82 / 98) |
| 2 | 120° left (behind-left), 60° up | 0.6451 / −26.6 | seam 16, middle | normal column 10 (90 / 106) |
| 3 | 90° right, 75° up | 0.6250 / 15 | seam 0, top of the image | mirrored 88/87 |
| 4 | dead ahead, 20° up | 0.5278 / 0 | seam 64, upper-middle | the seam itself (80 and mirrored 80) |
| 5 | overhead (89°) | 0.6250 / 1 | above the image's fitted top: shows what the dome does at the zenith | mirrored 88/87 |

### Result of the sixth pass (2026-09-19): the predictions held

| id | target | ahead of the car (read) | sun (read) | verdict |
| --- | --- | --- | --- | --- |
| 1 | 30° right, 30° up | mirrored 83/82 → 34° | seam 48, middle of the row | heading ✓, row ✓ (higher in it than the linear fit said) |
| 2 | 120° left, 60° up | normal 90/91 → 124°, sun on the left | seam 16, a bit below the middle | ✓ |
| 3 | 90° right, 75° up | mirrored 88/87 → 90° | top ring (row 0), half way between the pole and the ring's edge, above normal 17 | ✓ |
| 4 | dead ahead, 20° up | the seam (64 / mirrored 64, 80 / mirrored 80) | seam 64, middle of the row, straight above the car's nose | ✓ |
| 5 | overhead (89°) | — | a few degrees from the pole where all columns meet | ✓ |

1. **The model is good enough to build the sun tool on.** Five targets
   chosen in advance, five hits: heading within half a column every time,
   the right row every time, left/right as predicted, and latitude ≈ 0 at
   noon really puts the sun overhead. It now lives in `src/core/sun.ts`
   (`sunDirection`, `solveSun`, `dayTime01FromMapHours`) with tests, and in
   `tools/sky_mod.py --sun`.
2. **The top of `SkyColor.dds` is the zenith.** Looking straight up, the
   columns pinch into a pole, so the linear fit from the fifth pass (top row
   reached at 76°) was wrong at the high end. Image latitude against the
   model's height, all readings so far:

   | real height | 0° | 5° | 20° | 25° | 30° | 45° | 60° | 75° | 90° |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | image latitude | −7.5 | −1 | 22 | 22..26 | 37 | 50 | 66 | 83 | 90 |

   Steep near the horizon (the horizon is half a row BELOW the image's
   middle line, 20° up is already 22°), then roughly "real + 6°" up to the
   pole. Readings are good to a third of a row (±5°). Anything painted into
   a sky (horizon glow, a sun halo) should go through this table, not a plain
   equirectangular mapping.
3. **The sun disc wanders a few degrees around the seam** (both sides, up to
   about 5° of arc, at every height). The dome follows the sun's heading
   only approximately, or the disc and the dome use slightly different
   inputs. Too small to matter for lighting; it means a sun painted into the
   image would not sit exactly under the game's disc.
4. Still open: what night does (the 06:00 glow), and a height check that
   does not go through the sky image — a shadow cast by a block of known
   height, in a screenshot or a computed lightmap, would give the sun's
   height to a degree.

## 9. The sun tool (built 2026-09-19)

Section 5's wish, on top of section 8's model. In the editor: `SunTool` +
`SunDome` (drag the sun over a dome, moon opposite), the "Sky & light"
drawer page (sun numbers and colours, fog and tint, sky image), previewed
live. On save (`tools/gameBridge.ts`): `meshdump moodmod` writes the four
mood settings files with the sun moved and recoloured, `sky_mod.py --append`
adds a sky image with its rows moved to their real height (the table above),
`meshdump build` points the map at the zip and applies the mood, `meshdump
atmosphere fog=` adds the fog clip next to the map's own clips.

Checked here: a save with all three (`Maps/Trackedit/Sun tool test`: orange
sun 30 degrees right of the start and 30 up, orange fog, a test sky) reads
back with the mod reference, the patched settings and the fog clip. NOT yet
checked in game: that the whole save looks as previewed, and — the big one
for custom lighting — that **computing shadows in the game with the mod
active bakes the custom sun** into the lightmap. If it does, custom baked
lighting needs no baker of our own.

Sharing (same day): the zip is reproducible (fixed entry timestamps) and
named by its hash; after a save the editor walks the author through
download / show in folder, upload, paste the link, and the bridge verifies
the link serves exactly that zip before writing it into the map's mod
reference (`/api/game/mod/*`). Not yet seen: the game downloading the mod
from such a link on a machine that lacks the file.

Open: Night (where the moon really is), merging the
sun into a map's existing texture pack, ambient colour and colour grading
(`Fx/ColorGrading`) as further controls.

## 10. Experiment — does the old bake survive a small edit? (2026-09-19, awaiting the in-game look)

A save now keeps every original object in its original file order and appends
new ones, so in theory the old lightmap still lines up with everything that
was not touched. `meshdump build` takes `"keepLightmap": true` in the
placements JSON to keep the bake despite changes. Three copies of Simple 25
in `Maps/Trackedit`, each one edit away from the original, old lightmap kept:

| map | edit | what to look for |
| --- | --- | --- |
| LM keep A - one start added | a second RoadTechStart, appended last | is only the new block unlit/odd, or does the game reject the whole bake / ask to recompute? |
| LM keep B - one item deleted | the third item removed (every later item shifts up one in the list) | do the items after it show the WRONG shadows (mapping is by index), or all fine (mapping is by something else)? |
| LM keep C - one checkpoint moved | GateCheckpoint two cells over, same list position | does it carry its old shadows to the new place, leaving a ghost shadow behind? |

B is the informative one for the baker: it says whether the cache maps
objects by list position.
