# trackedit style guide (ground truth)

Status: **authoritative** — every UI change checks against this document.
Written 2026-08-30, before the vertical-toolbar rebuild.

## 1. Direction

A dark, fast, cockpit-like editor. Influenced by the *feeling* of TM2020's
menus — bold slanted type, skewed geometry, confident single-accent color on
near-black — while staying legally distinct:

**We deliberately do NOT use:** Nadeo's green-on-green checkered-fade card
motif, their leaf/flag green (#00a651-family) as a primary, their logo
letterforms, or parallelogram *cards* as content containers.

**We take only the abstractions:** speed-lean shapes, a disciplined
one-accent palette, chunky uppercase labels, and high-contrast focus states.
Our identity: **graphite + circuit teal + kicker orange**.

**Density: markedly more compact than TM2020.** Their UI is a couch/console
UI — huge targets, generous air. Ours is a desktop tool: tight rows, small
type, minimal padding, information-dense panels. When a spacing decision is
in doubt, pick the tighter option. Concretely: panel padding 8px, control
gaps 4px, list rows ≤ 26px, section headers 10px uppercase.

## 2. Color tokens

Paste-ready CSS custom properties. Nothing outside this table appears in UI
chrome (viewport content — meshes, gizmos — has its own rules, §7).

```css
:root {
  /* surfaces */
  --bg-void:   #0a0e11;  /* viewport surround, deepest */
  --bg-0:      #10151a;  /* app background */
  --bg-1:      #161d24;  /* panels, rails */
  --bg-2:      #1e2731;  /* raised: inputs, hover rows, chips */
  --bg-3:      #27323e;  /* pressed / active-row fill */
  --stroke:    #2c3844;  /* hairlines, panel borders */

  /* ink */
  --ink-0:     #e9eff4;  /* primary text */
  --ink-1:     #9fb1bf;  /* secondary text */
  --ink-2:     #5f7181;  /* disabled, hints */

  /* identity accents */
  --teal:      #14d0a4;  /* PRIMARY: active tool, tabs, focus, links */
  --teal-dim:  #0d8a6e;  /* pressed/derived */
  --orange:    #ff8c1a;  /* SECONDARY: layer identity, warnings-adjacent */
  --gold:      #ffc83c;  /* selection outlines in-viewport, pinned states */
  --green-ok:  #35d07f;  /* success, height guides, "aligned" feedback */
  --red:       #ff4f5e;  /* destructive, errors */
}
```

Usage law: **teal is the only interactive accent in chrome.** Orange marks
layer identity (plane outlines, layer chips). Gold belongs to selection.
Green means "confirmed/aligned". Never two accents on one element.

## 3. Shape language

- **Skew** is the signature: interactive *labels and chips* skew
  `transform: skewX(-8deg)` (text content counter-skewed +8deg so glyphs
  stay upright). Panels and buttons stay rectangular — skew is seasoning,
  not structure.
- **Chamfer, don't round**: corners use small clip-path chamfers
  (`polygon` cutting one 6px corner, usually top-right) or square corners.
  Border-radius ≤ 3px only on tiny elements (tags, inputs).
- **Active-edge bar**: active states get a 3px teal bar on the element's
  leading edge (left for vertical rails, bottom for tabs).
- Hairline borders (`1px var(--stroke)`), no drop shadows except panel
  slide-overs (single soft `0 8px 24px #0008`).

## 4. Typography

- **Headings / labels / buttons**: "Chakra Petch" (Google font, distinct
  from Nadeo's faces), fallback `"Segoe UI", system-ui`. Uppercase,
  `letter-spacing: 0.08em`, weight 600. Section headers 11px, buttons 12px.
- **Body / data**: same family sentence-case 13px, or `Consolas` for
  numbers (coordinates, degrees, counts) so digits align.
- Italic slant is reserved for the HUD sequence letters and big "mode"
  callouts — not body text.

## 5. Components

### 5.1 Tool rail (replaces the top toolbar)

- Vertical, fixed left, `40px` wide, `--bg-1`, hairline right border.
- Square `32×32` icon buttons, centered, 2px gap, tooltip on hover
  (name + shortcut, e.g. "Place — P").
- States: idle `--ink-1` icon on transparent; hover `--bg-2` + `--ink-0`;
  **active** `--bg-3` + teal icon + 3px teal left bar.
- Order: Place (P), Select (E), Erase, ─ divider ─, Import, Export,
  ─ spacer ─, Settings (future). Undo/redo live in the status bar.
- Icons: inline SVG, 16×16, `stroke-width: 1.5`, geometric/angular
  (no filled blobs), `currentColor`.

### 5.2 Block drawer (slides from the rail)

- Opens when Place activates (icon click or `P`); slides `260px` from the
  left over the viewport. Motion: `transform 180ms cubic-bezier(.2,.8,.2,1)`.
  Esc or activating another tool closes it. Pinnable later.
- Column layout: search field → **tabs** → tag filter strip → virtualized
  list. 8px outer padding, 4px gaps.
- **Tabs**: `TRACK` | `ITEMS` — uppercase 11px, bottom teal bar on the
  active tab, inactive `--ink-1`.
- List rows: 24px, name in sentence case 12px, tag chips right-aligned;
  hover `--bg-2`; armed row = teal left bar + `--bg-3` (same grammar as
  the rail).

### 5.3 Tag chips (block taxonomy)

Small skewed chips (`skewX(-8deg)`, 10px font, 2px 6px padding, colored
border + tinted fill at ~18% opacity, text at full color). One special
exception: **finish** renders a tiny black/white checker fill — on a *chip*,
not a surface, which keeps it far from Nadeo's trade dress.

| tag group | tag | color |
|---|---|---|
| surface | tech | `#8fa1b3` steel |
| surface | dirt | `#c9803f` |
| surface | bump | `#a06a52` |
| surface | ice | `#6fd3e8` |
| surface | grass | `#58c25c` |
| surface | plastic | `#ffd23f` |
| surface | water | `#3fa6ff` |
| surface | snow | `#dfe9f2` |
| surface | sausage | `#e08b8b` |
| geometry | straight | `#6c7c8c` |
| geometry | corner | `#9d7bff` |
| geometry | slope | `#c77bd8` |
| geometry | loop/wallride | `#ff7bb8` |
| geometry | pillar/structure | `#7e8ea0` |
| special | start | `var(--green-ok)` |
| special | checkpoint | `#3f9cff` |
| special | finish | checker chip |
| special | multilap | `#3fd0c9` |
| effect | boost | `var(--orange)` |
| effect | slowmo | `#b09aff` |
| effect | reactor | `#ffb03f` |
| effect | no-engine / no-brake | `#f2e63f` |
| effect | fragile | `#ff8f6f` |

Tags derive from block-name heuristics first (`RoadDirt…` → dirt,
`…Curve…`/`…Turn…` → corner, `…Start…` → start), later from real
`BlockInfo` metadata (waypoint type is already in `meta`).

### 5.4 HUD, status bar, viewport furniture

- HUD (sequence input): unchanged position; letters in gold italic
  monospace, meaning in `--ink-1`; container `--bg-1` at 85% opacity.
- Status bar: single line, `--ink-1`; undo/redo buttons live at its right
  end as small icon buttons.
- Viewport overlays keep their assigned colors: orange layer planes, gold
  selection boxes, green height guides/plumb line, teal reserved for future
  snapping guides.

### 5.6 Menu bar & menus

- Slim 26px bar above the layout: brand, `File` (and future menus), spacer,
  current track name right-aligned in `--ink-2`.
- Menu buttons are quiet (no chrome until hover); popups use the dialog's
  chamfer + shadow, items reuse the row grammar (teal edge bar on hover).
- Dividers group: create/open · import/export · destructive-ish.

### 5.7 Persistence conventions

- Storage is **IndexedDB** (localStorage is ~5MB — too small for big maps);
  only editable state is stored (layers + placements + map meta), never
  geometry. Every track must have a **name** before it exists in the DB.
- The current track id lives in localStorage; on boot it reloads, otherwise
  the **map browser** dialog opens (New track button on top, rows: name ·
  placement count · age · delete-with-warning).
- Autosave on every edit (debounced ~800ms); destructive flows (New over a
  non-empty track) confirm with "all track data has been saved".

## 6. Motion & feedback

- Durations: 120ms (hover/press), 180ms (drawer slide), 240ms max ever.
  Easing `cubic-bezier(.2,.8,.2,1)`. No bounces.
- Every mode change surfaces in ≤1 place: rail state OR HUD — never both
  announcing the same thing.
- Keyboard-first: every rail action shows its shortcut in the tooltip.

## 7. Viewport content rules

Chrome colors never leak into 3D content: placeholder blocks keep their
category tints, real meshes their textures. Guides follow §2 accent
meanings. Ghosts are always 45% opacity clones of the real thing.

## 8. Keyboard map (current)

`P` place · `E` select · `F` toggle fly · `T/R` transform · `C` camera
sequences · `L` (in T/R) layer target · scroll build height ·
Alt+scroll dolly · MMB orbit · Shift+MMB pan · RMB hold = fly (alt to F).
`S` is reserved forever for WASD flight — never bind it.
