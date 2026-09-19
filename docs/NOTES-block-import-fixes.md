# Notes: fixing the imported block meshes

Status: **working log** — written 2026-09-07, covering the September 2026
work on why "almost every block in the map looks wrong". This is the story
of what was actually broken, how we found it, and how to keep checking.
The mechanics themselves are documented in the README (*Real block meshes
& textures* and *Validating clip geometry*); this document is the reasoning.

## 1. The complaint

Textures looked rotated 90° or 180°, parts were drawn that shouldn't be,
end caps sat on the wrong face, side walls floated outside blocks. It
looked like a texture problem across the whole library. The instinct to
resist was fixing blocks one at a time: the library has ~5600 blocks, and
every per-block patch hides a real rule we hadn't understood yet.

## 2. What the blocks actually are

A TM2020 block is not one mesh. `CGameCtnBlockInfo` gives, per variant
(air / ground):

- **Mobils** — the body geometry (a prefab or solid), often reused between
  blocks and, crucially, sometimes placed through a **geometry transform**
  on the mobil itself (`GeomRotation` + `GeomTranslation`).
- **Units** — the grid cells the block occupies, each with clip lists per
  face (north/south/east/west/top/bottom). Clips are separate block-info
  files with their own geometry and are what the game shows on faces that
  are free (nothing attached) — end caps, undersides, terrain skirts, and
  for several families (deco cliffs, stage supports, deco walls) the
  *entire* visible block.
- **Vertical clips** (`*VFC`) are tables of wall segments, not one mesh:
  Middle / Top / Bottom / TopBottom rows plus merged multi-unit middles.
- **Terrain modifiers** swap materials by slot (dirt, plastic, special
  effects) — already handled before this round.

Every "texture rotation" we chased turned out to be geometry: a clip on the
wrong face, the wrong wall segment row, a body never rotated, a cap that
belonged to a different half of the block.

## 3. How we found the real causes

The turning point was **ground truth**. Guessing whether a render "looked
right" from memory of the game was slow and often wrong. Two things fixed
that:

1. **The game's own icons.** Every block-info header carries `IconWebP`,
   the editor icon the game renders for that block. `meshdump icons`
   dumps all ~3900. They are stored upside-down (flip vertically) and are
   taken from our sheet camera at yaw 315, pitch -30 — verified on chiral
   blocks (wall checkpoints, loop starts, expandable gates), because
   symmetric blocks can't tell a camera from its mirror. Some families
   (Stage*, Structure*) have blank or wireframe icons; skip those.
2. **Structural inspection instead of eyeballing.** `meshdump nodeinfo`
   (every parsed field, one level into variants and mobils),
   `unitinfo` (which clip on which face of which unit), `clipinfo` /
   `clipobj` (a clip's raw geometry per row), `geomxf` (every mobil with a
   transform), plus the per-source breakdown of an exported OBJ (the
   `.src.json` sidecar says which vertex range came from the body and
   which from which clip). The scratch scripts that rasterise a source's
   footprint as ASCII were the fastest way to see "this cap covers the
   south half of the corridor, and the second copy is a 90° turn of it".

The workflow that emerged, and that we should keep using:

1. Put suspect blocks in a review map (`tools/catalog_sample_map.py`), or
   Shift+click a set in the editor and read it back from
   `/api/debug/state`.
2. `tools/block_sheets.py --list names.txt` captures each one in isolation
   from three angles; paste the flipped icon beside view 1.
3. For each family that differs, inspect the data (above) until the
   *rule* being violated is clear. Fix the rule in `meshdump`, not the
   block.
4. `tools/reimport_selection.py` (or `meshdump blocks … @names.txt`)
   re-exports just those blocks in seconds; reload; recapture; compare.
5. Only when a family is clean, run the full library export (~40 min),
   `tools/check_clips.py` for overhangs, `tools/test_curve_clips.py`, and
   recapture the catalog for a regression look (`tools/sheet_diff.py`,
   `tools/icon_match.py` as coarse triage).

Practical notes: capture from a *foreground* browser tab — a background tab
is throttled to about two blocks a minute versus a hundred. When several
tabs are open, pass `--client` so the screenshots come from the right one.

## 4. What was wrong, in order of blast radius

| Symptom | Cause | Fix |
| --- | --- | --- |
| Wall checkpoints' arch lying on the floor, wall a dark plane | Mobil `GeomRotation`/`GeomTranslation` ignored (270 mobils carry one; the 40 wall checkpoints rotate the flat ground checkpoint prefab onto the wall) | Apply the transform to every mobil, body and clip. Rotation is (x, y, z) degrees in that order; pinned by tests in `tools/meshdump.tests` |
| Deco cliff corners missing two arms; stage supports rendered as boxes or nothing | Clip validation gate measured against geometry merged so far, so on mesh-less blocks the first wall rejected every wall on the far faces | Gate against the body, or the block's own cells when there is no body |
| Wall stacks showing four "lone wall" segments; wrong trims | Densest row of a vertical clip used regardless of context | Choose Middle/Top/Bottom/TopBottom from whether the same wall continues on the unit above/below |
| Chicane and diagonal plates covering half the road, second copy turned 90° | A cap attached to two units is one plate in point-symmetric halves; the four-yaw scoring had nothing under the corridor to score against | Add "stays inside the block" and "doesn't overlap a placed copy" terms |
| Green slabs radiating from snow roads and gates | Ground *bodies* carry terrain-blend skirts like ground clips do | Trim the ground body to the footprint too |
| Water pools with a grey lid | Water ships only a normal map; glass an alpha texture | `water` / `translucent` flags in `materials.json`, translucent materials in the renderer |

Earlier rounds (documented in the README) had already fixed terrain
modifiers, sign panel content, decal z-fighting, cap yaw scoring, inward
turns for wall panels and skirt trimming of ground clips.

## 5. What is still wrong

- **StageSupportCurve1Out / Curve2Out.** Their arc walls are authored two
  cells away from the face they attach to (raw z 64..96 for a south clip),
  unlike any other clip we have seen, and the inner and outer arcs are not
  concentric in their raw frames. Our placement rule can't seat them, and
  the top cap then mis-orients against the fragments.
- **PlatformBase** gained a top face with the vertical-clip row change;
  its icon can't confirm whether that's right.
- **Back-face culling.** The game culls back faces; our renderer is
  double-sided, so open corridors show the near wall where the icon shows
  the far wall's inner face. Cosmetic, but it confuses icon comparisons.
- The pillar clips under elevated snow roads render as legs; the icons
  don't show them, and we haven't confirmed in-game behaviour.

## 5b. Custom items embedded in maps (icecomp, TMX #84337)

"Big empty spots where custom geometry is missing" turned out to be two
rules we hadn't read, not missing data:

- **Items rotate about a pivot.** The anchored object stores
  `PivotPosition`; custom items made in the Mesh Modeler typically pivot at
  their centre (`[-16, -6, -16]` for a 32 m half-banked slab). We rotated
  about the model origin, so every flipped (pitch 180°) or turned piece
  landed a cell away and 6–10 m low — the "missing" pieces were the dark
  slabs stranded next to the track. Fix: carry `pivotPos` through the dump,
  the placement and the renderer (`pos + R * pivot`). The ghost line was
  the reference: it drives exactly over the pieces once they are placed
  right.
- **Custom meshes name materials by path.** Crystal exports say
  `Stadium\Media\Modifier\PlatformIce\PlatformTech`; fbx-style items
  bind a `CPlugMaterialUserInst` whose `Link` is that path. The library is
  keyed by the short names the block extraction produces
  (`PlatformIce.PlatformTech`), so nothing matched and every custom item
  drew flat grey. One canonicalisation, applied at export (and as a
  fallback on the client for older libraries), fixed all of them.
- The user's `.trackedit.local.json` pointed TMX import at an older
  external `gbxdump` that has no `pivotPos`. The bundled converter now runs
  first; the override is a fallback.

- **Rotation order.** The stored yaw/pitch/roll is applied yaw → roll →
  pitch (three.js "YZX"), not yaw → pitch → roll. Measured on TMX #84440
  ("you just got COLLEGED!"): scoring how many record-ghost samples lie
  within 2.5 m of each tilted free block's mesh gave 569 for YZX against
  319 for YXZ, and YZX won or tied on every block that has both pitch and
  roll. Blocks with only one of the two never showed the bug, which is why
  it survived so long. `core/math.ts` now owns the order
  (`GAME_EULER_ORDER`, `quatFromGameRot`, `gameRotFromQuat`); the renderer,
  the transform operator and the exporter all go through it.

- **Clip caps are per side, not per block.** Three cruise-control
  platforms in a row (TMX #84442) each showed their end "turbines" and the
  record line drove straight through them. The block's unit carries a clip
  on every face (`PlatformFCSmall` north/south, `PlatformSpecialFCRight` /
  `...Left` east/west, `PlatformBaseFCB` below), all in clip group
  `PlatformFCSmallClips`; the map lists no clip blocks at all. So the game
  shows a clip only on an open side and hides it when the neighbour's facing
  clip shares the group. We had baked every clip into the block mesh. Now
  each clip is its own OBJ group and the renderer hides joined ones from
  neighbour lookups (`render/clipAdjacency.ts`, pure, tested). This is the
  same mechanism for every block family: platform trims, deco walls, base
  undersides joining the top-cap group of the block below.

Still open: tracko's `gbxbuild` writes `PivotPosition = 0` for every item,
so an exported map would put custom items back in the wrong place in-game
until it reads the `pivotPos` the editor now emits.

## 5c. Placed blocks name a VARIANT of their block (RHEVARA, TMX #357419)

Report: a deco-wall loop end (`DecoWallLoopEndGrass`) drew its concrete on
the side the record line drives through; "there must be a block setting for
whether the support concrete is drawn".

There is, and we ignored it. A block definition holds more than the air /
ground pair: `AdditionalVariantsAir` / `AdditionalVariantsGround`
(`meshdump unitinfo` lists them). For this block: `Variant Air`, `Variant Air
InPillar`, and a second `Variant Air` whose wall clip sits on the SOUTH face
instead of the west one — the mirrored layout. `PlatformBase` has the same
three (`InPillar Air` is the look a platform takes stacked inside a pillar).
A placed block picks one with **flags bits 21 and up** (0 = base, 1 =
InPillar, 2… = the further layouts); GBX.NET exposes bit 21 only as the
unnamed `Bit21`. On this map: 4,318 blocks name variant 1 and 1,442 variant
2, and all 153 `DecoWallLoopEndGrass` name variant 2 — every one of them was
drawn mirrored. Checked against the record line: through the base variant it
crosses a wall of the selected block, through variant 2 it crosses nothing.

Fix, generic: `meshdump blocks` exports every additional variant that
differs from its base as `air1.obj`, `air2.obj`, `ground1.obj` … (identical
ones are dropped — most InPillar variants look like their base) with their
unit and clip tables; `blockVariantIndex` (core/layer.ts) reads the index
from a placement's flags; the renderer asks for `air2` etc. and falls back to
the base when a variant has no mesh of its own. Needs a block re-extraction.

A wrong turn on the way, kept as a warning: the first attempt "fixed" the
symptom by changing how the extractor orients underside shells on body-less
blocks. It rotated correct meshes. When a block looks wrong, first ask which
field of the MAP says what to draw.

Still unread on a placed block: `Variant` / `SubVariant` (flags' low bits),
which choose among a variant's `Mobils[variant][subVariant]` — the extractor
always takes `[0][0]`.

## 6. Lessons

- Get a reference before judging. The icons settled arguments in minutes
  that had taken hours of staring (StageSupportCross was fine all along).
- When "every block is wrong", look for a field being ignored, not for
  bad data. Every fix this round was a rule we hadn't read.
- Keep the loop small: select, re-import those blocks, reload, compare.
  The full export is for confirmation, not iteration.
- Check calibration on chiral objects. A symmetric block cannot tell you
  which way the camera faces or whether an image is flipped.
