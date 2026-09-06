# trackedit

A web-based Trackmania 2020 map editor: three.js viewport, searchable block
palette, layers with per-layer grid settings and transforms, and `.Map.Gbx`
import through a bundled GBX.NET converter. Export produces placement JSON
for the separate gbxbuild toolchain.

## Getting started

The repo ships **no game assets** — block meshes and textures are Nadeo's
content, so you extract them once from your own TM2020 install. You need:
Trackmania 2020, [Openplanet](https://openplanet.dev/), Node 22+ (there's a
`mise.toml` if you use [mise](https://mise.jdx.dev/)), and the
[.NET 8 SDK](https://dotnet.microsoft.com/) (for the converter).

```
npm install
npm run dev        # http://localhost:5199
```

Open the editor and follow the **Get started** dialog — it walks you through
the one-time asset setup:

1. Point it at your `OpenplanetNext` folder (auto-detected on the default
   install). It installs the bundled **Trackedit Extract** Openplanet plugin
   for you (from [`tools/TrackeditExtract`](tools/TrackeditExtract)).
2. Launch TM2020 with Openplanet and set plugin signature mode to
   **Developer** (F3 → Openplanet menu → Developer → Signature mode) so the
   local plugin loads, then click **Trackedit Extract** in the Openplanet
   menu. It extracts the ~18k files the editor needs to
   `OpenplanetNext/Extract` (a few minutes; the dialog watches the folder).
3. Back in the editor, hit **Import models & textures** — meshdump converts
   the extraction into `public/meshes/` (OBJs + PNG textures, gitignored).

The dialog can't be skipped — real geometry is a prerequisite, so it stays
until all three steps are done (it's one-time; it never shows again once the
import exists). Afterwards the box icon at the bottom of the tool rail
reopens it in manage mode: change the folder, re-import after a game update,
or remove the imported assets. Extracted assets stay on your machine — never
commit or redistribute them.

## Map pipeline

### Automatically sync blocks with the running game

With the dev server and Trackmania running on the same machine:

1. Open **Live editor** and click **Install / pair game plugin**. This uses the
   Openplanet folder configured in asset setup.
2. Load/reload **Trackedit Live** in Openplanet with Developer signature mode.
   It requires **Editor++**; Map Together is not required.
3. Open a map in the game's editor, outside testing/driving, and close in-game dialogs.
4. Click **Connect and load game map** in trackedit. The current browser map is
   saved first, and the game map opens as a separate browser document.
5. Close the dialog and edit in either editor. Block placements, deletions,
   moves/rotations, ground/ghost/free modes, variants, colors and waypoint fields
   sync automatically. **Disconnect auto sync** stops syncing and keeps the
   browser document.

The bridge polls snapshots approximately twice per second while connected and
sends batches of block changes with game revision checks and placement readback.
It preserves identical duplicate blocks, includes hidden layers in sync, and bakes
layer transforms into free blocks. Edits to different blocks merge; conflicting
edits to the same block pause sync and preserve the browser edits. Connecting
again saves that browser document and loads the game's current state.

Game items are loaded on a locked, read-only layer and update from the game.
Editing items in the browser pauses block sync. Skinned blocks are visible but
protected from edits through this bridge. Terrain, generated clips, embedded asset
transfer, and map settings are outside this block-sync protocol. Unknown meshes
use placeholders. This is not a complete archival map import.

Browser undo/redo generates inverse block changes. Incoming game changes that
alter the browser document clear its undo stack to avoid undoing stale remote
placements. Each outgoing batch creates a game undo point. A rejected/partial
batch stops sync; reconnect to inspect actual game state instead of blindly
retrying. Large edits are limited to 2000 additions/removals per batch. Game map
switches, browser map switches and dropped connections require reconnecting.
Only one browser tab may sync with the game at a time.

Reinstall/pair and reload Trackedit Live after restarting the dev server (its
pairing token changes). The local bridge is available through `npm run dev`, not
in the static production build. Plugin source: [`tools/TrackeditLive`](tools/TrackeditLive).

### File conversion

```
.Map.Gbx --(meshdump map)--> map.json --Import--> edit --Export--> placements.json --(tracko gbxbuild)--> .Map.Gbx
```

- TMX import uses the `map` command in [`tools/meshdump`](tools/meshdump), built on
  [GBX.NET](https://github.com/BigBang1112/gbx-net). The dev server builds it
  on first import using the .NET 8 SDK (or a newer SDK with the .NET 8 runtime)
  and runs its managed DLL on Linux, Windows, or macOS. First build needs
  NuGet access unless packages are already cached. No local configuration
  is needed. Existing `TRACKEDIT_GBXDUMP` / `.trackedit.local.json` `gbxdump`
  settings override the bundled converter with an external executable.
- To convert a local map manually:
  `dotnet run --project tools/meshdump -c Release -- map input.Map.Gbx output.json`.
  Run converter contract checks with
  `dotnet run --project tools/meshdump.tests -c Release`.
- Writing `.Map.Gbx` still requires `gbxbuild` from the companion **tracko**
  toolchain; this repo does not include that writer.
- The converter reads placed blocks and items, including grid/free transforms,
  flags, variants, colors, waypoint fields, skins, item pivots and scales.
  Extra placement fields ride along in `placement.meta` and export unchanged.
  This is not a full archival dump: arbitrary GBX chunks, replay data, and
  all game-specific metadata are not preserved. Capturing pivot/scale metadata
  does not add support for those transforms to the renderer.
- Layers with a non-identity transform (translate/rotate) export as *free
  blocks* — the game grid can't represent them, but the game renders them fine.
- `npx tsx tools/export_cli.ts <map.json> <out.placements.json>` runs the same
  import/export code headless.

## Architecture

Strict layering — lower layers never import from higher ones:

```
core/     pure domain: document, layers, placements, commands (undo/redo),
          catalog, math. No DOM, no three.js. Everything mutates through
          Command objects so plugin edits are undoable too.
io/       trackoJson import/export (the gbxdump/gbxbuild JSON dialect)
render/   three.js adapters: SceneView (canvas/camera/lights), CameraRig
          (Blender-style orbit/pan + RMB fly), DocumentRenderer (mirrors the
          document, one Group per layer), geometry providers
tools/    editor tools (place/select/erase) driven by ToolManager
plugins/  the EditorContext API; built-in features register through it —
          anything we can do internally, a third-party plugin can do
ui/       framework-free DOM panels (palette, layers, toolbar, statusbar)
main.ts   composition root — the only file that knows every concrete class
```

`window.trackedit` exposes the full `EditorContext` (+ `io`) in the console.

### Geometry providers

`render/GeometryProvider.ts` is the seam for block visuals:

- `PlaceholderProvider` — footprint-sized boxes, always works.
- `MeshProvider` — serves real meshes from `public/meshes/` (see below),
  lazy-loads OBJs, hot-swaps them in as they arrive, falls back to
  placeholders for anything missing.

## Real block meshes & textures

TM2020's ~4000 block meshes live in `Packs/Stadium.pak`, encrypted with keys
only the running game has, so extraction must run inside the game via
[Openplanet](https://openplanet.dev/). The **Get started** dialog (see
Getting started above) automates the whole flow through the dev server's
`/api/setup` bridge; the moving parts, for doing it by hand:

- [`tools/TrackeditExtract`](tools/TrackeditExtract) — the Openplanet plugin
  (copy the folder into `OpenplanetNext/Plugins/`). Its `extract_list.txt`
  is the complete set of file paths trackedit needs; the plugin extracts
  them by exact path via the Fids API (which also resolves the hashed pak
  names Pack Explorer can't) into `OpenplanetNext/Extract/`.
- `tools/meshdump` — the converter (C#, GBX.NET):

  ```
  cd tools/meshdump
  dotnet run -c Release -- blocks "%USERPROFILE%\OpenplanetNext\Extract\GameData\Stadium" ..\..\public\meshes
  dotnet run -c Release -- items  "%USERPROFILE%\OpenplanetNext\Extract\GameData\Stadium" ..\..\public\meshes
  ```

  The optional filter is a name substring, or `@names.txt` for a file of
  exact block names (re-export a hand-picked set in seconds).
  `python tools/reimport_selection.py` does that for whatever is selected
  in the editor tab (Shift+click a set) and reloads the tab — the loop for
  iterating on a few problem blocks without the ~40 min library pass.

  Other meshdump commands: `missing <root> <out.txt>` (after a game update,
  regenerate the list of newly-referenced files to append to
  `extract_list.txt`), `refs`/`matinfo`/`iteminfo <file>` (debug single
  files), `nodeinfo <file>` (every parsed property, one level into the
  variants and mobils — where the geometry transforms show up),
  `unitinfo <BlockInfo.Gbx>` (which clip attaches to which unit face),
  `clipinfo <root> <ClipId>` (a clip's raw, unplaced geometry bounds per
  mobil row), `clipobj <root> <ClipId> <air|ground> <row> <out.obj>` (that
  raw geometry as OBJ), `geomxf <root>` (every mobil carrying a geometry
  transform), `icons <root> <outDir>` (each block's editor icon as WebP —
  the game's own render, the ground truth for reviewing exports). Set
  `MESHDUMP_TRACE_MATERIAL=<name>` to print which block and reference first
  registered a material — the tool for "why does X have the wrong texture".

This writes one OBJ per block variant and item, diffuse textures
(DDS → PNG ≤512px) in `public/meshes/textures/`, `index.json` (footprints
included) and `materials.json`. The editor picks everything up on reload.

How the materials are resolved (the parts that go wrong when skipped):

- **Terrain modifiers.** Variant blocks (`PlatformDirt*`, `PlatformPlastic*`,
  every `*Special<Effect>*`, the gameplay gates) reuse one base mesh and
  swap materials through the block's `MaterialModifier`/`MaterialModifier2`
  references. Each points at a game-skin (`GameSkin/*.GameSkin.gbx`, the
  list of swappable slots and the material each normally uses) plus a
  folder under `Media/Modifier/` holding replacements named after those
  slots. meshdump applies both, second wins, and exports the result as
  `<Folder>.<Slot>` (e.g. `Fragile.Decal`, `PlatformDirt.PlatformTech`).
  Without this every special platform shows Turbo chevrons and every dirt
  platform the tech surface. A replacement with no shader and no textures
  is a "null" material: the game draws nothing for it, so those faces are
  dropped. GBX.NET can't read some skins (`TrackWallToDecoCliff`, the
  obstacle and penalty ones); their slot lists are recovered from the
  decompressed bytes. An unknown skin swaps nothing — never guess a slot
  list, the one-slot `TrackWallToDecoCliff` skin is what every plain tech
  platform references.
- **Sign / chrono panels** (`*_DispIn` shaders) put their content — turbo
  arrows, checkpoint digits — in the `MulInside` slot; the base color is
  just the LED-cell backdrop. That slot is preferred as the exported
  texture, so the backdrop-only look means an old texture cache.
- **Decals** (`DecalGeom` shaders) are flagged `decal` in `materials.json`.
  They sit exactly on the surface they mark; the renderer draws them with
  a depth bias and alpha blending so they don't z-fight the base surface
  (the "half the top face is grey" symptom). `TAdd` glow strips are
  flagged `blend: "add"`.
- **Projected textures** (`Py*`/`Pxz*` slots) ignore mesh UVs; UVs are
  synthesised from world position with the bitmap's `DefaultTexCoordScale`
  (1/32 = one tile per grid cell; plastic and canopy tile at 1/8).
- Each `materials.json` entry records its `source` image, so a re-import
  regenerates a PNG whenever the chosen slot changes rather than trusting a
  file of the same name.
- The UV vertical convention needs no flip: on every vertical face carrying
  the upright TRACKMANIA logo, V grows with world up, which matches
  three.js's default `flipY`.
- **Water and glass.** Water surfaces ship only a normal map
  (`Water_SxSySz`), glass walls an alpha texture (`*_T`); they are flagged
  `water` / `translucent` in `materials.json` and drawn translucent instead
  of as opaque grey lids.

How the geometry is assembled (`meshdump nodeinfo` shows the fields):

- **Mobil geometry transforms.** A block's mobil can carry
  `GeomRotation`/`GeomTranslation` (270 do): the game rotates the referenced
  prefab before placing it. The wall checkpoints reuse the flat ground
  checkpoint prefab stood up against the wall this way (`(-90, 0, 180)` +
  `(32, 32, 32)` for "Down"); most bottom caps carry a plain +8 lift.
  Rotation is (x, y, z) degrees applied in that order. Ignoring it left the
  checkpoint arches lying on the floor.
- **Vertical clip rows.** A vertical clip (`*VFC`) is a table of wall
  segments, not one mesh: air rows are Middle, Top, Bottom, TopBottom, then
  merged Middle×2/3/4/8/16/32; ground rows are Bottom and TopBottom. The
  segment a unit shows depends on whether the same wall continues on the
  unit above/below within the block (a lone 8u wall is TopBottom; a 32u
  platform wall is Bottom, Middle, Middle, Top). The names in the prefab
  files confirm the order; they are matched by name with the index as
  fallback.
- **Ground bodies** carry the same terrain-blending skirts as ground clips
  and are trimmed to the block's cells the same way.
Extracted game assets are Nadeo's copyrighted content — keep them local,
never commit or redistribute them (`public/meshes/` is gitignored).

The mood skyboxes in `public/sky/` are CC0 sky photographs from
[Poly Haven](https://polyhaven.com/), baked to 2k equirects by
`tools/fetch_skies.py`.

## Controls

Open **Controls** in the top menu to choose **Trackedit** (the existing
default), **Blender**, or **Plasticity**. Changes apply immediately and are
remembered in this browser across maps and reloads. The dialog shows the
active shortcuts.

| Action | Trackedit | Blender | Plasticity |
| --- | --- | --- | --- |
| Orbit | MMB drag | MMB drag | MMB drag |
| Pan | Shift+MMB | Shift+MMB | RMB or Shift+MMB |
| Zoom | Alt+wheel (dolly) | Wheel or Ctrl+MMB | Wheel or Ctrl+MMB |
| Build height | Wheel | Alt+wheel | Alt+wheel |
| Move / rotate | T / R | G / R | G / R |
| Frame selection | Frame button | Numpad . | / |
| Fly mode | F or hold RMB | Shift+backtick | Shift+backtick |
| Confirm transform | Enter / left click | Enter / left click | Enter / left or right click |
| Cancel transform | Esc / right click | Esc / right click | Esc |

Blender and Plasticity use WASD + Space/C only in fly mode. Esc, the fly
shortcut, or a click exits toggled flight. P (place/grid ↔ free), E (select),
Delete, and Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z remain editor shortcuts. X also
deletes in the select tool with either modeling preset. Presets cover
navigation and supported transforms; scaling and mesh-editing commands
are not implemented. Reference mappings:
[Blender navigation](https://docs.blender.org/manual/en/4.3/editors/3dview/navigate/navigation.html)
and [Plasticity keymap](https://github.com/nkallen/plasticity/blob/master/src/startup/default-keymap.ts).

The following describes the default **Trackedit** scheme:

- **Left click** — active tool, **P** — place mode (press again to toggle
  **grid ↔ free** placement; free places anywhere on the layer plane at the
  build height), **E** — select mode
- **Click-drag in grid place** — paints blocks across cells (one undo step)
- **X/Y/Z while placing** — constrain placement to that axis from where the
  ghost was (Y slides vertically); click places & releases, right-click/Esc
  releases without placing
- **R** — rotate armed block (place tool), **scroll** — build level up/down
  on the active plane; while placing, a green plumb line shows the height
  and green outlines mark everything at the same level
- **Del** — delete selection, **Ctrl+Z / Ctrl+Y** — undo/redo
- **WASD + Space/C** — fly movement is always on (steady pace, Ctrl sneak,
  Shift sprint); **F** toggles mouselook (F or any click lands you), or
  hold **RMB**. `S` is never bound to anything — it belongs to flying.
- **Sequence shortcuts** (HUD shows the sequence bottom-left; left
  click/Enter commits, right click/Esc cancels — see
  [docs/SPEC-sequence-shortcuts.md](docs/SPEC-sequence-shortcuts.md)):
  - `c` `x|y|z` / `c` `l` `x|y|z` — slide the camera on a global / layer axis
  - `t` — translate selection (free); add `x|y|z` to constrain to an axis,
    two axes for a plane; snaps to the piece's layer grid
  - `r` [`x|y|z`] — rotate selection (personal frame); grid blocks snap to
    quarter turns on Y — pitch/roll (or a typed non-90° yaw) converts the
    block to a free block, exactly in place
  - `l` inside `t`/`r` — retarget the **layer itself** (move/spin the whole
    plane); with nothing selected, `t`/`r` targets the active layer directly
  - type digits for exact values (`t` `x` `-` `9` `9` → −99 m), Backspace
    edits, Enter confirms
- **MMB drag** — orbit, **Shift+MMB** — pan, **Alt+scroll** — slide the
  camera along its view direction, **Ctrl+scroll** — raise/lower the camera
  straight up/down (world axis, ignores layer tilt)
- **Hold RMB** — fly: mouselook + **WASD**, **Space/C** up/down, steady pace
  with **Ctrl** sneak and **Shift** sprint

## Catalog

`public/catalog.json` (3,769 official blocks + 763 Nadeo items with usage
counts) is generated by `tools/build_catalog.py` from a corpus of parsed maps.
Regenerate with `python tools/build_catalog.py <parsed-maps-dir>`.

## Roadmap

- Blender-style sequence shortcuts / modal operators (`c y`, `t l x -99`,
  numeric input, HUD) — see [docs/SPEC-sequence-shortcuts.md](docs/SPEC-sequence-shortcuts.md)
- meshdump: all variants + ground/air selection by placement, icons, textures
  (DDS → PNG/KTX2), materials
- Vertex/edge snap modes, align-to-plane across selections
- Multi-select, grouping, gizmo translate/rotate
- Custom item/block support (embedded assets)
- Instanced rendering for very large maps

### Inspecting rendering problems

Select a block and click **Frame** in the status bar to move the camera around
its bounds. Click **Isolate** beside it to show only the selected blocks, then
**Show all** to restore the other blocks. Isolation only affects the current view;
it does not change saved layer visibility. The placement ID beside these buttons
can be copied for repeatable debug views.
With the editor tab open, the development server also provides:

- `/api/debug/command?action=inspect&uid=p_n_etm1`: world bounds, mesh vertex/UV
  counts, and material texture URLs, sidedness, and vertical-flip settings.
- `/api/debug/command?action=reload`: reload the editor tab (after a mesh
  re-import; edits autosave, so nothing is lost).
- `/api/debug/command?action=focus&uid=p_n_etm1&yaw=112&pitch=-5&distance=42`:
  frame that placement. Angles are degrees; negative pitch looks down. Omit
  distance to fit the block to the viewport, including narrow viewports.
- `/api/debug/screenshot?uid=p_n_etm1&yaw=112&pitch=-5&distance=42&isolate=1`:
  return a PNG with other placements temporarily hidden. Camera and visibility
  are restored after capture. Omit `isolate=1` to include surrounding blocks.
- `/api/debug/screenshot?target=view`: capture the current viewport.

Omit `uid` to use the selection. If multiple editor tabs are open, pass
`client=<client ID from /api/debug/state>` to target the tab that posted that
snapshot. Missing selections or placement IDs fail rather than capturing an
unrelated view. These endpoints are for the Vite development server.

### Validating clip geometry

After changing clip attachment transforms, regenerate the block meshes and run
`python tools/test_curve_clips.py`. This checks the open ends of flat and
banked quarter curves against exported clip geometry, and verifies that their
undersides remain present. Banked cap heights are also checked at both ends
against the road, catching caps that sit on the right face but face backwards.
`python tools/diagnose_clips.py air RoadTech` provides
a broader, heuristic attachment report. GBX east attaches at a unit's `x=0`
face and west at `x=32`; reversing these can put braces across a curved wall
while still passing a whole-block bounding-box overlap check.

The clip meshes themselves follow one authoring convention (`meshdump
clipinfo` shows it for any clip): a panel in the plane `z=32` spanning
`x 0..32`, looking into the adjoining cell. Every side-face clip — face caps
and one-piece wall panels alike — is therefore placed the same way: yaw to
the face, then turn inward about the face centre. Asymmetric panels (the
48-wide loop-start walls overhang one end) are the tell-tale: without the
inward turn they hang outside the block. Top and bottom caps carry no
direction either; they are tried at all four yaws and keep the one that
sits on the body — per cell of the cap's footprint, the body's height must
meet the cap (a coping strip turned 90° along a quarter pipe floats above
the curve; a thin wall's strip turned 90° covers empty cell). A cap the
game attaches to several units of one block (chicanes, diagonals) is one
plate split into point-symmetric halves, so each placement is also scored
on staying inside the block and off the copies already placed. Caps, and
every clip of a ground variant, are trimmed to the block's own cells: the
game's ground undersides and wall rows carry terrain-blending skirts that
spread several cells into the neighbours. A clip is kept only if it seats
against the block body; on blocks with no body of their own (deco cliffs,
stage supports are pure clip assemblies) it must reach the block's cells
instead — earlier the first wall merged rejected every wall on the far
faces.

Two more checks for a whole-library pass:

- `python tools/check_clips.py` scans every exported block for clip
  geometry outside its footprint and lists the worst offenders — compare
  the counts before and after a meshdump change.
- `python tools/block_sheets.py --reload` (editor tab open) captures every
  placement of the open map in isolation from three angles and writes one
  contact sheet per block to `sheets/`, for reviewing a whole map at once.
- `python tools/catalog_sample_map.py --per 21 --spread --open` builds a
  review map with blocks from every catalog category laid out in rows (evenly
  spread through each family, or the most-used ones without `--spread`),
  saves it through `/api/maps` and opens it in the editor tab.
- Reviewing by hand: in the select tool, Shift+click adds to or removes from
  the selection. `/api/debug/state` lists the selected placements with their
  block names, so a hand-picked set can be read back by a script and fed to
  `block_sheets.py --list names.txt` (one exact name per line).
- Ground truth: `meshdump icons <root> sheets/icons` dumps the game's own
  editor icon for every block. The WebP data is stored bottom-up (flip it
  vertically before comparing — unflipped, side faces appear on the far
  edges). Flipped, the icons match the sheets' first view (yaw 315,
  pitch -30; checked on chiral blocks — the wall checkpoints, the loop
  starts, the expandable gates), so an icon pasted beside a sheet is a
  direct A/B. Blocks with a non-zero `IconQuarterRotationY` are turned
  by quarter turns in their icon.
  `python tools/icon_match.py sheets/catalog sheets/icons` scores every
  sheet against its icon by silhouette; the bottom of that list is a
  coarse "look here first" (blank/wireframe icons are skipped).
- `python tools/sheet_diff.py sheets_before sheets_after` ranks blocks by
  how much their sheet changed between two captures — after a library-wide
  importer change, eyeball the top of that list instead of all 5000 blocks.