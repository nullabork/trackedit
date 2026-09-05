# Spec: Sequence shortcuts (modal operators)

Status: **planned** — written 2026-08-30, not yet implemented.

Blender-style chorded keyboard input: short key sequences arm a *modal
operator* that captures the mouse until confirmed or cancelled. This replaces
nothing — click tools stay — it layers a faster expert path on top.

## 1. Sequence input engine

- A key sequence is typed one key at a time (`c`, then `l`, then `y`), no
  modifier held. Each keystroke narrows the operator being built.
- **HUD**: while a sequence is active, the pressed letters show in a corner
  overlay together with their meaning, e.g.:

  ```
  C · L · Y      Camera · Layer axis · Y
  ```

  The HUD also shows the live numeric input (see §5) and the current delta
  ("+64 m", "-90°").
- `Esc` at any point during typing abandons the sequence.
- Sequences only start when the pointer is over the viewport and no input
  field has focus.
- The engine is a small state machine: `Idle -> Building(prefix) ->
  Modal(operator)`. Unknown next keys flash the HUD and stay in Building.

## 2. Camera moves (`c`)

- `c` `x` / `c` `y` / `c` `z` — mouse movement slides the **camera** along the
  chosen **global** axis, starting from where the camera currently is.
- `c` `l` `x|y|z` — same but along the **active layer's** axis (layers are
  independent planes with their own rotation/translation, so layer axes are
  the layer's rotated frame, not the world's).
- Switching the active layer while not in a camera move does not move the
  camera; the layer frame is sampled when the operator starts.
- **Left click** — lock in: keep the new camera position, exit the mode,
  sequence no longer active.
- **Right click** — cancel: restore the camera to where it was when the
  operator started, exit the mode.

## 3. Transform operators on selection (`t`, `r`)

Available whenever something is selected: whole placements now; later also
sub-elements (a face, an edge, a vertex — see §6).

### Translate

- `t` — free drag (screen-plane translate, any axis).
- `t` `x|y|z` — drag constrained to that single axis.
- `t` followed by **two** axes (e.g. `t` `x` `y`) — drag constrained to the
  plane those axes span.
- Movement snaps to **the grid increments of the layer the piece belongs
  to** (its `gridStep`, in that layer's rotated frame) — same rule the layers
  themselves follow.
- `l` — retargets the operator at the **layer itself** (implemented): the
  placement preview snaps back to rest and further input moves/rotates the
  selection's layer(s). With nothing selected, `t`/`r` starts in layer mode
  on the active layer directly. Layers rotate on **any axis** (full Euler
  transform), pivoting around the **centre of the layer's content** (map
  centre when empty); the stored translate is pivot-compensated so the
  plane tilts in place. Each layer draws an orange plane outline (dim for
  inactive layers) so its orientation is always visible.

### Rotate

- The pivot is the **average centre point** of everything selected —
  placements, or selected faces/edges/verts on one object — shown as a small
  marker in the viewport.
- `r` `x|y|z` — mouse movement rotates the selection around its **personal**
  axis: the object's own frame, i.e. an already-rotated block remembers its
  orientation and further rotations compose relative to it.
- `r` `l` — rotates the **layer(s)** of the selection instead (the placement
  stops rotating and returns to rest when `l` is pressed).
- Rotation snapping: mouse-driven rotation of a grid block on Y snaps to
  quarter turns (stays on the grid via `dir`); free placements snap to 15°;
  typed angles are exact.
- **Grid → free conversion** (implemented): pitching/rolling a grid block, or
  typing a non-quarter yaw, converts it to a *free block* on commit — the
  game grid can't hold it, but the game renders free blocks fine. The
  conversion is exact: the free `absPos` is derived from the rotated
  footprint corner so the piece doesn't move visually.

### Confirm / cancel (all transform operators)

- **Left click** or `Enter` — commit (one undoable Command).
- **Right click** or `Esc` — cancel, everything returns exactly to where it
  was.

## 4. Layer note

Layers act as independent planes with their own rotation and translation
(already true in the data model). All "layer axis" (`l`) variants read the
frame of the *placement's* layer for transforms, or the *active* layer for
camera moves.

## 5. Numeric input

After an operator + axis is armed, typing digits switches from mouse control
to typed control:

- `t` `l` `x` `-` `9` `9` → translate −99 along the layer X axis; typing
  another `9` makes it −999; the preview updates live at each keystroke.
- `Backspace` removes the last digit (−999 → −99).
- The number can be edited freely until:
  - `Enter` — confirm at the typed value;
  - `Esc` — cancel and restore the original transform.
- Units: metres for translate (grid-snapped unless a decimal is typed),
  degrees for rotate.

## 6. Select mode & sub-element selection (`s`)

- `s` enters **select mode** (today: activates the select tool).
- Full select mode (later): hovering the geometry of a placed piece
  highlights the nearest sub-element — a **face, edge or vertex** — which
  **glows and renders slightly larger** than its true size so it's easy to
  see and hit.
- Clicking a highlighted sub-element selects it (multi-select accumulates
  until you **click away** on empty space, which clears the selection).
- Selected sub-elements feed the rotate/translate pivot (the averaged centre
  point of everything selected) and future snapping modes (edge snap, vertex
  snap, align-to-plane).
- First cut of the operators works on whole placements with pivot =
  selection centroid; the operator design must not assume
  "pivot == placement origin".

## Architectural implications (respect these *now*)

These shape decisions we make before the feature lands:

1. **Input as its own layer.** Key handling moves out of individual tools
   into an input dispatcher that supports modal capture (an active operator
   swallows keys/mouse until it exits). `ToolManager` grows toward
   "operator manager"; click tools become one kind of operator.
2. **Preview vs commit.** Modal operators need cheap, cancelable preview:
   move the three.js objects live, only produce a document `Command` on
   confirm. Renderer must allow a placement's visual to be temporarily
   overridden without touching the document (cancel = drop the override).
3. **Frames everywhere.** Every transform is expressed in an explicit frame
   (world, layer, personal/object). Keep layer/world/local conversion helpers
   in `core` (pure math, unit-testable) rather than scattered in tools.
4. **Selection model.** Selection becomes first-class shared state (multiple
   placements now; typed sub-element selections later) with a derived
   centroid, not something private to SelectTool.
5. **HUD channel.** The shell needs a viewport overlay slot (corner text)
   separate from the status bar, drivable by the input engine.
