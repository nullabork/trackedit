# trackedit

A web-based Trackmania 2020 map editor: three.js viewport, searchable block
palette, layers with per-layer grid settings and transforms, and lossless
import/export to real `.Map.Gbx` via the gbxdump/gbxbuild toolchain.

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

```
.Map.Gbx --(tracko gbxdump)--> map.json --Import--> edit --Export--> placements.json --(tracko gbxbuild)--> .Map.Gbx
```

- `gbxdump` / `gbxbuild` come from the companion **tracko** toolchain (built
  on [GBX.NET](https://github.com/BigBang1112/gbx-net)) and are not part of
  this repo. Point the dev server at your `gbxdump` build via the
  `TRACKEDIT_GBXDUMP` env var or a `"gbxdump"` entry in
  `.trackedit.local.json`; the editor works without it — only TMX import
  needs it.
- Fields the editor doesn't model (flags, variants, waypoints, colors) ride
  along in `placement.meta` and export unchanged, so editing an existing map
  never destroys data.
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
