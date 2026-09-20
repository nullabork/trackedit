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

**Verification, and air vs ground.** `meshdump variantcheck <map> <GameData>
[meshesDir] [report.json]` (`npm run variantcheck` runs it over every cached
map; developer tooling, not an editor feature) checks every
block of a map against its definition: the variant it names has to exist.
Over five real maps (about 23,000 checked blocks, variants 0–4 in use) not one
names a variant its block lacks — which is also the proof that bits 21+ ARE
the variant index. The same pass showed our air/ground GUESS was wrong: the
editor said "ground" for y = 8 on a stadium base, but every block the files
flag as ground sits at y = 9, and pillars the file marks ground were drawn as
air. The map file says it per block (`isGround`), so that is now what decides
(`blockIsGround`, core/layer.ts): the file's flag for imported blocks — as
long as a ground block still sits at ground level — and "placed at ground
level on a stadium base" for blocks made in the editor.

Still unread on a placed block: `Variant` / `SubVariant` (flags' low bits),
which choose among a variant's `Mobils[variant][subVariant]` — the extractor
always takes `[0][0]`.

## 5d. "Why do we keep placing things wrong?" — a silent fallback converter (RHEVARA again)

Report: 13 inflatable tube pieces that should form one run sat apart, each
half a piece off. Measured instead of eyeballed: a tube piece has two ends,
and ends of neighbours must meet. Over the map's 73 tube pieces, 192
combinations of Euler order, angle signs, axis assignment and pivot sign
were scored by how many of the 146 ends land within 0.75 m of another:

| rule | ends that meet |
| --- | --- |
| the editor's rule (yaw→roll→pitch = three.js "YZX", `pos + R·pivot`) | **88** — the best of all 192 |
| next best (YXZ) | 80 |
| the same rule, pivots ignored | 20 |

So the placement maths was right (and is now confirmed from an independent
direction — the rest are open chain ends). The pivots were MISSING: the map
file stores one per item (exactly minus one tube end), `meshdump map` writes
it, the importer keeps it — but the stored track had none, on all 6,691
items, and no block indices either. It had been converted by the old
EXTERNAL `gbxdump` fallback: `dotnet build` of the bundled converter failed
because its files were locked by a running extraction, and the fallback took
over without a word. Every "this family is misplaced" report from a track
imported in such a moment has this one cause.

Fix, generic (tools/mapConverter.ts): a failed rebuild uses the build that
is already there; any converter's output is checked against the full field
list the editor places by (`DUMP_FIELDS`, `dumpProblems`) and a lossy dump is
REFUSED with the reason; the editor says so when it opens a track imported
that way ("open it again from TMX"). And two tests pin the dialect from both
ends: every field `meshdump map` writes must be present, and every field of
every record — unknown ones included — must come back out of the editor's
import/export.

## 5e. Caps turned away from their block (DecoWallCurve1Grass, RHEVARA)

Report: "the black section is extending past the curve". A quarter-round
deco wall whose quarter-disc top and bottom caps were turned 180°, filling
the corner the wall curves away from. Not a variant problem.

The extractor chose each cap's quarter turn by fitting its shape against the
block ("the attachment stores no direction"). For this block the four
candidates scored 25.0 / 25.5 / 23.7 / 26.7 — a coin toss, lost. But the game
does say: every cap clip carries `TopBottomMultiDir`, and of the 942 cap
clips nearly all are `SameDir` (the rest `SymmetricalDirs` / `AllDir`): the
cap faces the way its block does — NO turn.

**The check came first** (`tools/cap_check.py`, `npm run capcheck`): purely
geometric, so it judges the result whatever rule produced it — seen from
above, a cap has to lie inside the outline (convex hull) of the rest of its
block. It skips what it cannot judge (blocks whose other geometry does not
outline them, and ground "...Ground" undersides, which are terrain skirts
that spread on purpose). On the deco-wall family (655 blocks, 1,309 meshes):

| rule | blocks flagged |
| --- | --- |
| shape fit (before) | 111 |
| never turn (the data, taken literally) | 94 — fixes 26, but breaks 9 transition pieces whose turn WAS right |
| no turn unless the fit is decisive, ≥ 75 % better (now) | **86** — fixes the 26, newly flags 1 (`DecoWallWaterDiag`) |

What separated right turns from wrong ones: where turning was right the fit
improved by ~95 %; where it was wrong, by ~10 % on near-equal errors. The
extractor can write that evidence per cap (`MESHDUMP_CAP_REPORT=<file>`:
block, unit, clip, its `TopBottomMultiDir`, the chosen turn, all four
errors).

Open: 85 deco-wall blocks (slopes, loop starts, tilt transitions) are flagged
under every rule — either real, or sloped multi-unit shapes the top-view
outline test is too blunt for. Go through them before trusting the count.

## 5f. Dark plates poking through snow: caps are FREE clips (RHEVARA)

> **Superseded by 5h:** the game keeps a cap that another block overlaps (500 of 500 in its baked clips); the "swallowed cap" rule and `clipcheck` are gone.

Report: dark wedges all over a snowy slope; "rotations are wrong or sections
should not be rendered". The isolated block (`DecoWallSlope2StraightIce`)
shows what they are: its sloped TOP CAP, which is dark concrete
(`TrackWallClips`) in every terrain flavour — a cover for when nothing stands
on the wall. Here a snow hill (`DecoHillIceSlope2Straight`) shares the wall's
cells and reaches one cell higher, sloping another way, so the plate cut
through the snow. The hill has no clips at all, and our rule only hid a clip
when the neighbour carried one that JOINS it.

The game's own word: of its 1,718 clip definitions 1,717 have `ClipType`
`FreeClipTop` / `FreeClipBottom` / `FreeClipSide` — pieces for a FREE face.
Now (`render/clipAdjacency.ts`): a top or bottom cap is hidden whenever the
cell it faces is occupied, by anything. Side clips keep the joining rule for
now.

Check: `npm run clipcheck` (tools/clip_check.ts) runs maps through the
editor's import and adjacency code and fails on any cap shown against an
occupied cell. It also lists side clips shown against occupied cells — on
RHEVARA 15,571 of them (587 × `DecoWallBaseVFC` against `PlatformBase`, the
water edge clips against deco walls, …). By the same "free" reading those
should probably go too; held back until a case shows which way the game does
it, because hiding a wall face beside a block that only partly fills its cell
would open a hole.

## 5g. Two corrections the next day (RHEVARA, the arch over a platform)

> **Superseded by 5h:** the game keeps a cap that another block overlaps (500 of 500 in its baked clips); the "swallowed cap" rule and `clipcheck` are gone.

**The cap rule of 5f was too broad.** "Hidden whenever the cell it faces is
occupied" also removed the underside of `DecoWallArchSlope2EndIce` — the arch
IS its bottom piece, and a platform merely stands in the cell below. The two
cases differ in one thing: the snow hill that must hide the wall's top plate
fills the plate's OWN cell too (the plate is inside it); the platform is a
neighbour. Rule now: a cap is hidden when a neighbour's clip joins it, or when
another block swallows it — fills the cap's cell and the one it faces.
`npm run clipcheck` fails on swallowed caps that are shown and lists the rest.

**Tall shells on wall-only blocks were left unturned.** The game names this
arch's base variants "Variant Air WrongDir"; the map uses variant 2, the
proper "Variant Air", whose curved walls sit on other faces. The shell has to
follow the walls, and the fit knew (errors 7.0 / 8.0 / 8.1 / 5.7 once it
compares along the walls only, `CapMismatch(shellOnly)`), but the "decisive"
bar of 5e (75 %) — calibrated on the noisy whole-footprint score — held it
back. Blocks with no body now fit along their walls and turn on a 15 % gain.

The check grew a second test for it (`tools/cap_check.py`): a TALL cap's edge
has to follow the profile of the side walls on the faces it runs along (mean
height difference over shared columns, 3 m tolerance). It said the arch's
variant 2 was 4.2 m off and wanted a quarter turn, and that the loop end's
shell was 16 m off in its base variant. Deco-wall family under both tests:
138 blocks flagged -> 118, none newly flagged.

## 5h. The game's own clips are IN the map file — the clip rule, measured (RHEVARA)

**Report.** `DecoWallLoopEndIce` at [11,16,12]: "there is still some surface or shell
missing", and: "surely the game has a standard format for rendering, not 100s of edge
cases". It has. We had been guessing at it.

**Where the truth is.** Not in the editor's block lists (an Openplanet dump of
`PluginMapType.ClassicBlocks/GhostBlocks` on RHEVARA: 24,919 blocks, 0 clips — the
`IsClip` filter in TrackeditLive was defensive, not evidence; that plugin experiment is
deleted again). It is in the map FILE: `CGameCtnChallenge.BakedBlocks` — 31,648 entries in
RHEVARA, every clip block the game generated, with name, cell and direction.
`meshdump baked <map> [out.json]` dumps them. (5f's "map files store no clip blocks"
looked at `Blocks` only. trackedit's own saves clear the list; the game rebuilds it.)

**Measured conventions.** A clip block sits in the cell it FACES, not in its unit's cell
(26,915 vs 859 name matches); a side clip points back at its block (face direction +180°:
15,654 of 15,927).

**The rule** — `npm run cliptruth -- <map> --explain` tabulates, per situation, what the
game did. What fell out, all from fields of the clip DEFINITIONS that the extractor had
never read (`meshdump clipflags` lists them; `clipdefs.json` ships them, 1,848 clips
including the `Theme/` and `Deprecated/` subfolders the first pass missed):

| field | meaning |
|---|---|
| `ASymmetricalClipId` | mates with exactly that clip (curve cap top <-> bottom) |
| `SymmetricalClipGroupId` | mates with clips of THAT group (top plate <-> underside, Left <-> Right) |
| `ClipGroupId` | without the two above: mates within its own group; no group: with itself |
| `IsFullFreeClip` / `CanBeDeletedByFullFreeClip` | a deletable clip facing a FULL clip is gone — one way only |

A clip is hidden iff a clip on the face looking back at it mates with it or deletes it.
Nothing else: not a block that merely stands in the faced cell, not one overlapping the
clip's own cell, and ghost blocks (7,493 of RHEVARA's 24,514) count like any other —
"ghost blocks are off the grid" scored 63%.

| rule | RHEVARA, 139,072 clips | 7 cached maps, 176,343 clips |
|---|---|---|
| before (shared group or id; swallowed caps; `VerticalClipGroupId` used as the group) | 93.5% | — |
| definitions, partner must agree too | | 99.64% |
| definitions, the clip's own fields decide (shipped) | 99.8% | **99.65%** (624 differ) |

What the old rule got wrong, by size: deletable clips facing a full wall left showing
(~3,600); full walls hidden against partial panels of the same *vertical* group (~1,400,
the game keeps both); caps "swallowed" by an overlapping block hidden (5f/5g — the game
shows 500 of 500, that fix was wrong and is gone); caps facing a non-mating cap.

**The reported block itself** comes out the same as before — and the same as the game:
the baked clips around it are exactly its curved west panel, top plate and underside. Its
four back walls really are deleted (full wall against the loop start's full wall). What
looks open there is decided by the neighbours' clips, which is where the rule changed.

**Still open (624 clips, 0.35%).** Road ends against platform edge trims
(`OpenTechRoadFC` + zone clips facing `PlatformFCSmall`: the game drops both, no field we
read says so); `...ACLeft/Right` "anti clips" (`sym: PlatformFCSmallAntiClips`); caps
whose mating depends on direction — `TopBottomMultiDir` (SameDir / SymmetricalDirs /
AllDir) is a condition on the two caps' directions, and index.json does not carry a cap's
direction yet. The baked blocks DO (cliptruth prints each cap's direction relative to its
block), which is also the ground truth the extractor's cap shape-fit (5e) should be
checked against next, instead of `capcheck`'s outline heuristic.

**Tooling.** `npm run cliptruth` (all cached maps, totals; one map for detail; `--explain`
for the situation table and the wrong pairs) replaces `clipcheck`, whose one assertion
("no cap shown inside another block") the game contradicts.

## 5i. Free blocks name a variant too (RHEVARA, struts under a platform)

**Report.** Two free-placed `StructureSupport*` blocks under an oval platform showed
diagonal struts; "I think it should just be the curved black rail". Right: the file names
variant 1 for both (flags `0x20200040` = free + bit 21), `air1` is the bare rail (44 KB),
the base `air` is the rail with struts (408 KB).

**Cause.** `placementVariant` returned `"air"` for every placement that is not a grid
block. The variant is not derived from anything (unlike clips, 5h): it is STORED per
block — bits 21+ of the flags, plus the ground flag — and free blocks store it in the
same bits. Across the 7 cached maps 138 of 658 free blocks name a variant above 0, and
none is a ground variant.

**Fix.** Free (non-item) placements use `air<index>`. `npm run variantcheck` compared
grid blocks only, which is why it said 0 mismatches; it now compares free blocks as well
(38,000 blocks, 0 drawn with another variant than the file names).

**Not covered yet.** The flags carry two more fields, GBX.NET's `Variant` (bits 0-5;
151 blocks on RHEVARA) and `SubVariant` (bits 6-11; about 900). `SubVariant` indexes the
mobil WITHIN the chosen variant's row: `StructureSupportCurve1Out` has `[0][0]
SupportCurve1Out_Air` and `[0][1] ..._Airv2` (the colourizable build, extra `*Colorize`
materials). The extractor exports `[row][0]` only. Same shape in the cases looked at, so
it is a material / colouring difference rather than a wrong-looking block — but it is
unverified across the block set, and wants the same treatment: export per mobil, pick by
the file's field, check editor against file.

## 5j. Free blocks join their clips too — with each other (RHEVARA, a floor of reset gates)

**Report.** Sixteen free-placed `GateExpandableSpecialReset` blocks laid flat as a floor each
showed their own black frame; "these kinds of effect blocks should join together".

**Truth.** The gate's frame IS clips (`...RightVFC`, `...LeftVFC`, `...FCT`, `...FCB`), and
the editor never hid a free block's clips: no cell, no neighbours. But the game bakes clips
for free blocks as well — 1,355 of RHEVARA's 31,648 baked blocks carry the free flag, with a
pose in metres instead of a cell (`meshdump baked` now dumps `absPos`/`yawPitchRoll`). For
the four gates of one column it baked one top bar, one foot and four posts on the outer
side: the rest joined.

**Rule** (`src/render/clipFaces.ts`). Orientation-free: two clips face each other when the
centres of their unit faces coincide (0.5 m) and their outward normals are opposite; whether
that hides them is the same definition-field rule as for grid blocks (5h). Scored by clip
name against the baked free clips (`npm run cliptruth`), 2,029 free clip pieces on RHEVARA:

| free clips join... | off by |
|---|---|
| nothing (the editor until now) | 674 |
| free AND grid blocks | 50 |
| **each other only** (shipped) | **12** |

So free blocks live in a world of their own, like ghost blocks do NOT. The baked clips also
show the next thing to read: a vertical clip's `Variant` (0/1/2) picks the bottom, middle
or top piece of a post by what stands above and below it — the extractor guesses one row
(`DensestWallRow`).

## 5k. Every field, audited: what is kept on save, what is drawn by (all cached maps)

**Ask.** "Read all the fields, the subvariant etc. — when we save maps all the fields must be
saved correctly, and I want it to look good. Go through every piece and see if we are using
every flag that matters."

**Tool.** `meshdump fieldaudit <map>` reflects over every property GBX.NET exposes on a map's
blocks, free blocks, items and baked blocks: how often each is set, to what, and which of the
32 flag bits occur. `npm run fieldaudit` runs it over every cached map, twice:

1. *Kept on save.* The map goes through the real save path untouched and is audited again;
   every field must come out with the same counts and values. This sees what `roundtrip`
   cannot — fields our own dump never mentions (item snaps, skins, macroblock references,
   authors, decals). Result: all 7 maps, every field of every block and item survives (the
   save reuses the original objects). Baked blocks go to 0 by design; the game rebuilds them.
2. *Drawn by.* Every field that is set anywhere needs a verdict in the tool's REVIEW table
   (draws / kept / todo); one without a verdict fails the run, so a field added by a game
   update or a newer GBX.NET cannot go unnoticed. 41 fields are set across the maps.

**The flag bits, now all accounted for.** 0-5 `Variant`, 6-11 `SubVariant`, 12 ground,
14 pillar, 15 has author, 16 replacement, 20 waypoint, 21-26 block variant index (5c),
28 ghost, 29 free.

**What the audit turned up: Variant and SubVariant select a MOBIL.** A block variant's
`Mobils` is a table, and the extractor exported `[0][0]` only:

- `Variant` = the ROW. `StructurePillar` / `DecoWallCurve1Pillar`: `Air, (empty), Air2, Air3,
  Air4, Air8, Air16, Air32` — the pillar's height piece, one row drawing nothing at all.
- `SubVariant` = the COLUMN, an alternative build: `TopCornerOut10m_Air / _AirB / _AirBv2`
  (another shape), `Curve1_Air / _Airv2` (other materials).

About 2,000 blocks on the cached maps name one (984 + 147 on RHEVARA). Now: the extractor
writes every mobil that differs from what it would fall back to as `<tag>@<row>_<col>.obj`
(same dedupe as variants; mobils without any geometry are listed as `emptyMobils`) plus the
table's shape (`mobils`); `placementMobil` reads the two fields (grid and free blocks), the
renderer asks for `<variant>@<row>_<col>`, and the provider falls back mobil -> variant ->
base. `npm run variantcheck` checks every named mobil lies inside its variant's table.
After the re-extraction: 1,057 blocks have a mobil table, 4,600 mobil meshes differ from
their fallback (+2.7 GB of OBJ, +16%), 3,093 mobils are empty; 3,336 placed blocks on the 7
cached maps name a mobil and none lies outside its table. Seen in the editor: a
`DecoCliffTopCornerOut10m` naming `[0][2]` loads 2,217 vertices (`air@0_2.obj`), not the
base's 1,050.

**Still to do** (the tool lists them): block `Skin` (sign images, and the surface of deco
walls and pillars — `Skin.Text` like `PlatformIce\`), item `PackDesc` / `ForegroundPackDesc`
(item skins), item `Scale` (1 on every item seen). And from 5j: a baked clip block's own
`Variant` picks the bottom / middle / top piece of a post.

## 5l. Block skins: a pillar's surface comes from the platform above it

The audit's biggest "not drawn" field: 8,865 blocks on the cached maps carry a `Skin`. All
but one are PILLAR blocks (`DecoWallBasePillar` 8,136 on RHEVARA, `DecoWall*Pillar`,
`WaterWall*Pillar`) with `Skin.Text` = `PlatformGrass\`, `PlatformIce\`, `PlatformDirt\` or
`PlatformPlastic\` and no image pack: the name of a TERRAIN MODIFIER. It is the mechanism the
extractor already applies for blocks that have a modifier of their own (`DecoWallBaseGrass`
is `DecoWallBase` + `PlatformGrass`): a game-skin maps base materials to slots, the modifier's
folder holds the replacements. A pillar has no modifier of its own — the game stores, per
placed pillar, which one the platform above it uses.

- `meshdump skins` (also part of every block extraction) writes `skins.json`: per modifier,
  base material -> replacement (`TrackWall -> PlatformIce.TrackWall`, 11 swaps for ice and
  dirt, 5 for grass, 2 for plastic; the gameplay modifiers — Boost, Turbo, Reset… — come along),
  and registers every replacement so its texture is converted.
- `placementSkin` reads the text (grid and free blocks); the renderer asks for
  `<variant>[@<row>_<col>]#<skin>`; the provider loads the same mesh with the swaps applied, as
  a template of its own.
- `npm run variantcheck` fails on a skin that `skins.json` does not know.

Seen in the editor: pillars skinned ice / grass / dirt load `PlatformIce.TrackWall`,
`PlatformGrass.TrackWall`, `PlatformDirt.TrackWall`. Not drawn yet: a skin that names an
image pack (one `TechnicsScreen4x1` on RHEVARA), and item skins.

## 5m. Wall panels are one wall across blocks: Middle / Top / Bottom / TopBottom

The baked clip blocks carry a `Variant` of their own (11,640 of RHEVARA's 31,648). For a
VERTICAL clip (a wall panel) it is the row of the clip's mobil table: `Middle, Top, Bottom,
TopBottom, (empty), Middle x2, x3, x4, x8, x16, x32` in the air — the last seven being a
stack of Middles drawn as one tall piece plus the empty slots it covers — and `Bottom,
TopBottom` for a panel standing on the ground. Top and Bottom carry the trim along a wall's
upper and lower edge.

The extractor already picked the segment — but only by looking inside ONE block
(`WallRowMobil`, "does the wall continue on the unit above/below"). A one-cell block
(`DecoWallBasePillar`: 8,587 on RHEVARA) therefore always got TopBottom, however tall the
stack of them.

**Rule, measured** (`wallSegments`, scored by `npm run cliptruth` against the baked variant):
a panel has the wall continuing above / below it when a SHOWN panel of the same
`VerticalClipGroupId` looks the same way from the cell directly above / below — in this
block or any other; ghost or not makes no difference (asking for equal ghostness drops
RHEVARA from 92.7% to 83.8%).

| map | panels | rule | always TopBottom |
|---|---|---|---|
| RHEVARA | 9,469 | 92.7% | 31.9% |
| Islander | 3,494 | 95.3% | 40.6% |
| tmx-1 | 1,260 | 97.6% | 46.7% |
| tmx-84457 | 555 | 97.5% | 32.3% |

**How it ships.** `clipdefs.json` gains `vgroup`. The extractor writes, next to each wall
panel part, the segments a neighbour could turn it into — `<part>~a` (a panel above),
`~b` (below), `~ab` — skipping any that is the same mobil as the default. They load hidden;
the renderer shows exactly one per open panel, and re-evaluates the blocks diagonally above
and below a change as well, since whether THEIR panel shows decides a neighbour's segment.
Free blocks keep the per-block answer.

Horizontal clips use the same field as a neighbour bitmask (`WaterHFCLeft`: rows 0, 4, 8, 12
of 16; `WaterHFCRight`: 0..3) — not read yet.

## 5n. Item scale and item skins

- **Scale.** `placementScale`: the renderer scales an item uniformly about its anchor (pivot
  offset included). It is 1 on all 13,038 items of the cached maps, so this is unverified
  against a map that really uses it.
- **Item skins** (`PackDesc`, `ForegroundPackDesc`) are now in the map dump (`skin` on items).
  On RHEVARA 153 of 159 are light COLOURS — `Skins\Stadium\LightColors\White.dds`, `Coral`,
  `Orange`, `WhiteCold`, `Off`, and `LightTube\Orange.zip` — on `ShowLights`, `Lamp`,
  `LightSphere`, `LightTube*`; the rest are screens showing a game image or a URL, one with a
  `.webm` foreground.
- **Light colours, drawn.** NOT via Openplanet: a "skins only" folder run of the extract
  plugin found `Skins\Stadium\LightColors` under none of the four Fids roots (the plugin is
  back to what it was). They ship as a plain zip next to Trackmania.exe,
  `Packs/Stadium_Skins.zip`: 20 `LightColors/<Name>.dds` images and 20 EMPTY
  `LightTube/<Name>.zip` — a tube's colour is keyed by that name. `meshdump skins` (and every
  block import) finds the install (`TRACKEDIT_GAME_DIR`, else the usual Steam / Epic /
  Ubisoft Connect places on every fixed drive — all of them, merged: an abandoned launcher's
  old copy here held 10 colours, the current one 20) and writes `lightcolors.json`, each
  image's colour (mean weighted by brightness; `Off` is black). An item with such a skin loads
  as a template of its own (`#light:<file>`) whose light-emitting materials take the colour
  and glow in it: those made from an `*_I.dds` illumination map (`ItemLampLight`,
  `LightShape`) and a light tube's own surface. Not drawn: screens. Stored maps converted
  before item skins were in the dump need re-opening from TMX.
- **Fresh installs.** The Get started dialog gained an optional game-folder row (found by
  itself; `POST /api/setup/gamedir`), passes it to the import, rebuilds a converter that is
  older than its source, and tells an existing install which data its import predates.

## 5o. Wall copings turned across the wall, walls with no outside: two heuristics replaced (tmx-33114)

**Report.** `PlatformTechWallStraight`, `...4`, `PlatformIce/PlasticWallStraight`: "the end cap
textures are wrong, or have the wrong pivot, or are placed wrong — there should be a standard
way of rendering any block".

**What was wrong, from the mesh alone.** The wall runs along z at x = 30..32. Its top coping
lay along it; its BOTTOM coping lay across it (x 0..32, z 0..2) — a strip sticking out
sideways from every wall. And the wall's outer face (`PlatformWallStraightFC`, a full 32 x 8
panel) was not in the mesh at all.

**1. Cap direction: the game's, not a fit.** Looked for a stored direction once more, properly:
`TopClipDir` / `BottomClipDir` exist on a block unit but are empty in all 89,946 units (an
older format), and the unit `Dir` is North even in blocks whose caps the game turns by 90, 180
and 270 degrees. The definitions as GBX.NET reads them carry no cap direction. The result,
though, is in every map: the baked clip blocks have a direction, and
`npm run cliptruth -- --harvest` reads, per exact cap (`block|variant|clip|face|unit`), the
quarter turn relative to its block — kept when seen at least twice and in four of five
sightings — into `tools/meshdump/cap_turns.json` (761 caps from 8 maps, 244 of them turned),
which ships beside the converter. A game direction of k is the extractor's turn -k (checked
where the fit is unambiguous: wall copings, loop-start and slope tops). The extractor places
a known cap by it — body-less blocks included, which the fit could not do at all — and fits
shapes only for caps no map has shown yet. For these walls the game says 90 for top AND
bottom; the fit had scored that turn lowest for the bottom too (12.9 against 28.6) and was
held back by its own "must be 75% better than no turn" threshold.
`MESHDUMP_CAP_REPORT` now records the fit's turn next to the game's, and `npm run capfit`
says how often the fit agrees where the game is known — i.e. what to expect of it elsewhere.

**2. The placement gate: "touches the body" -> "sits on its own unit's cell".** Every clip is
built into a scratch buffer and committed only if it seats; the test was a gap of at most
1.5 m to the block's BODY. That fails every thin-walled block: a wall's body is one plane 2 m
inside its outer face, a loop start's deck is 2 m above its underside plate. `npm run
clipgeom` (clips listed in index.json without a part in the mesh) counted 5,299 of 146,031:
234 outer wall faces, 258 + 108 deco-wall back panels of loop starts, 2,932 `PlatformBaseFCB`
underside plates (cliffs, loop starts — all baked by the game), stage and cliff side pieces.
What the gate exists to reject is a block-space clip re-attached to several units, whose
copies land a cell off. So a clip now also passes when it sits on ITS OWN unit's cell and
inside the block's box — a side panel on its unit's face, a cap that fits within its unit's
cell; anything wider than a cell still has to meet the body. `MESHDUMP_GATE_LOG=1` says which
clips a block loses and why.

## 6. Lessons

- Get a reference before judging. The icons settled arguments in minutes
  that had taken hours of staring (StageSupportCross was fine all along).
- When "every block is wrong", look for a field being ignored, not for
  bad data. Every fix this round was a rule we hadn't read.
- Keep the loop small: select, re-import those blocks, reload, compare.
  The full export is for confirmation, not iteration.
- Check calibration on chiral objects. A symmetric block cannot tell you
  which way the camera faces or whether an image is flipped.
- A fallback that degrades silently is worse than a failure. If the good
  path cannot run, fail loudly or verify what the fallback produced.
- Measure placement, do not eyeball it: things that must connect give a
  number (ends that meet), and a number can rank every convention at once.
- Every fix of a CLASS of bug ships with a check that scans for the rest of
  the class (`npm run roundtrip`, `variantcheck`, `capcheck`): the report
  that found one block should find the other hundred.
