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

  Other meshdump commands: `missing <root> <out.txt>` (after a game update,
  regenerate the list of newly-referenced files to append to
  `extract_list.txt`), `refs`/`matinfo`/`iteminfo <file>` (debug single
  files).

This writes one OBJ per block variant and item, diffuse textures
(DDS → PNG ≤512px) in `public/meshes/textures/`, `index.json` (footprints
included) and `materials.json`. The editor picks everything up on reload.
Extracted game assets are Nadeo's copyrighted content — keep them local,
never commit or redistribute them (`public/meshes/` is gitignored).

The mood skyboxes in `public/sky/` are CC0 sky photographs from
[Poly Haven](https://polyhaven.com/), baked to 2k equirects by
`tools/fetch_skies.py`.

## Controls

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
