import { BufferGeometry, Line, LineBasicMaterial, Vector3 } from "three";
import type { Object3D } from "three";
import type { EditorContext } from "@plugins/api";
import { AddPlacementCmd, CompositeCmd } from "@core/commands";
import type { Command } from "@core/commands";
import type { Placement } from "@core/layer";
import type { Dir, GridCoord, Vec3 } from "@core/math";
import { clampCoord, newId, rotateDir } from "@core/math";
import { layerAxisWorld, mouseAlongAxis } from "@input/frames";
import type { AxisName } from "@input/frames";
import type { Tool, ToolPointerEvent } from "./Tool";

type PlaceMode = "grid" | "free";

interface Constraint {
  axis: AxisName;
  /** Target when the constraint was armed (layer-local). */
  anchorCell: GridCoord;
  anchorPos: Vec3;
  /** Accumulated vertical offset (metres) for the Y axis. */
  yAccum: number;
}

/**
 * Click-to-place with a live ghost preview.
 *
 * - `P` (or the rail toggle) switches GRID mode (cell-snapped; click-drag
 *   PAINTS across cells as one undo step) and FREE mode (anywhere on the
 *   layer plane at the current build height; click places).
 * - `X`/`Y`/`Z` while moving constrains placement to that axis from where
 *   the ghost was (Y slides the piece vertically). Click places and
 *   releases the constraint; right-click or Esc releases without placing.
 * - `R` rotates, scroll changes the build height.
 */
export class PlaceTool implements Tool {
  readonly id = "place";
  readonly label = "Place";

  private modeState: PlaceMode = "grid";
  private armed: string | null = null;
  private dir: Dir = 0;
  private ghost: Object3D | null = null;
  private lastCell: GridCoord | null = null;
  private lastLocal: Vec3 | null = null;
  private constraint: Constraint | null = null;
  private painting = false;
  private rightReleasedConstraint = false;
  private stroke: Command[] = [];
  private lastPaintKey: string | null = null;

  constructor(private ctx: EditorContext) {
    ctx.events.on("blockArmed", ({ name }) => {
      this.armed = name;
      this.refreshGhost();
      if (ctx.tools.activeTool !== this) ctx.tools.setActive(this.id);
    });
    // Ghost starts as a placeholder box; swap in the real mesh when it lands.
    ctx.events.on("geometryLoaded", ({ name }) => {
      if (name === this.armed) this.refreshGhost();
    });
    // The ghost lives inside the active layer's group so it sits on that
    // layer's (possibly tilted) plane — re-home it when the layer changes.
    ctx.document.events.on("activeLayerChanged", () => this.refreshGhost());
    ctx.document.events.on("reset", () => this.refreshGhost());
    // The drop line's length depends on the build height.
    ctx.tools.events.on("buildLevelChanged", () => this.refreshGhost());
  }

  get mode(): PlaceMode {
    return this.modeState;
  }

  get hint(): string {
    return this.modeState === "grid"
      ? "Grid place · click/drag paints · X/Y/Z constrain · R/right-click rotate · scroll height · P free mode"
      : "Free place · click places on the plane · X/Y/Z constrain · R/right-click rotate · scroll height · P grid mode";
  }

  setMode(mode: PlaceMode): void {
    if (mode === this.modeState) return;
    this.modeState = mode;
    this.releaseConstraint();
    this.refreshGhost();
    this.ctx.events.emit("placeModeChanged", { mode });
    this.ctx.ui.setStatus(this.hint);
  }

  toggleMode(): void {
    this.setMode(this.modeState === "grid" ? "free" : "grid");
  }

  activate(): void {
    this.refreshGhost();
  }

  deactivate(): void {
    this.releaseConstraint();
    this.endStroke();
    this.dropGhost();
  }

  // --- targeting ---

  /** Layer-local placement target for the current pointer + constraint. */
  private target(ev: ToolPointerEvent | null): { cell: GridCoord; pos: Vec3 } | null {
    const cell = ev?.cell ?? this.lastCell;
    const local = ev?.localHit ? ([...ev.localHit] as [number, number, number]) : this.lastLocal ? ([...this.lastLocal] as [number, number, number]) : null;
    if (!cell || !local) return null;

    const step = this.ctx.document.activeLayer.settings.gridStep;
    let outCell: GridCoord = cell;
    let outPos: Vec3 = local;

    const c = this.constraint;
    if (c) {
      if (c.axis === "x") {
        outCell = [cell[0], c.anchorCell[1], c.anchorCell[2]];
        outPos = [local[0], c.anchorPos[1], c.anchorPos[2]];
      } else if (c.axis === "z") {
        outCell = [c.anchorCell[0], c.anchorCell[1], cell[2]];
        outPos = [c.anchorPos[0], c.anchorPos[1], local[2]];
      } else {
        const dyCells = Math.round(c.yAccum / step[1]);
        outCell = [c.anchorCell[0], c.anchorCell[1] + dyCells, c.anchorCell[2]];
        outPos = [c.anchorPos[0], c.anchorPos[1] + c.yAccum, c.anchorPos[2]];
      }
      outCell = clampCoord(outCell, this.ctx.document.size);
    }
    return { cell: outCell, pos: outPos };
  }

  private makePlacement(target: { cell: GridCoord; pos: Vec3 }): Placement | null {
    if (!this.armed) return null;
    const def = this.ctx.catalog.get(this.armed);
    const yaw = (-this.dir * Math.PI) / 2;

    if (def?.kind === "item") {
      const step = this.ctx.document.activeLayer.settings.gridStep;
      const pos: Vec3 = this.modeState === "free"
        ? target.pos
        : [
            target.cell[0] * step[0] + step[0] / 2,
            target.cell[1] * step[1],
            target.cell[2] * step[2] + step[2] / 2,
          ];
      return { id: newId("p"), kind: "free", block: this.armed, pos, rot: [yaw, 0, 0], isItem: true };
    }

    if (this.modeState === "free") {
      // Free blocks: off-grid but on the layer plane at build height.
      return { id: newId("p"), kind: "free", block: this.armed, pos: target.pos, rot: [yaw, 0, 0], isItem: false };
    }
    return { id: newId("p"), kind: "block", block: this.armed, coord: target.cell, dir: this.dir };
  }

  // --- pointer ---

  onPointerMove(ev: ToolPointerEvent): void {
    if (ev.cell) this.lastCell = ev.cell;
    if (ev.localHit) this.lastLocal = [...ev.localHit] as [number, number, number];
    if (this.constraint?.axis === "y") {
      const layer = this.ctx.document.activeLayer;
      const axisWorld = layerAxisWorld("y", layer.transform);
      const ref = this.ghost?.getWorldPosition(new Vector3()) ?? new Vector3();
      const mpp = Math.max(this.ctx.view.camera.position.distanceTo(ref), 40) * 0.0016;
      this.constraint.yAccum +=
        mouseAlongAxis(ev.native.movementX, ev.native.movementY, axisWorld, this.ctx.view.camera) * mpp;
    }
    this.updateGhost();

    if (this.painting && !this.constraint) {
      const t = this.target(ev);
      if (!t) return;
      const key = t.cell.join(",");
      if (key !== this.lastPaintKey) {
        this.lastPaintKey = key;
        this.placeAt(t, /* intoStroke */ true);
      }
    }
  }

  onPointerDown(ev: ToolPointerEvent): void {
    const layer = this.ctx.document.activeLayer;
    if (layer.locked) {
      this.ctx.ui.setStatus(`Layer "${layer.name}" is locked`);
      return;
    }
    const t = this.target(ev);
    if (!t) return;
    if (!this.armed) {
      this.ctx.ui.setStatus("Pick a block in the palette first");
      return;
    }

    if (this.constraint) {
      // Click places and releases the constraint.
      this.placeAt(t, false);
      this.releaseConstraint();
      return;
    }

    if (this.modeState === "grid") {
      this.painting = true;
      this.stroke = [];
      this.lastPaintKey = t.cell.join(",");
      this.placeAt(t, true);
    } else {
      this.placeAt(t, false);
    }
  }

  onPointerUp(): void {
    this.endStroke();
  }

  onRightDown(): void {
    if (this.constraint) {
      this.releaseConstraint();
      this.rightReleasedConstraint = true;
    }
  }

  /** Quick right-click rotates the ghost 90° around the layer's up axis
   * (the ghost lives in the layer group, so this is layer-relative). */
  onRightClick(): void {
    if (this.rightReleasedConstraint) {
      this.rightReleasedConstraint = false;
      return;
    }
    if (!this.armed) return;
    this.dir = rotateDir(this.dir, 1);
    this.updateGhost();
  }

  private placeAt(target: { cell: GridCoord; pos: Vec3 }, intoStroke: boolean): void {
    const layer = this.ctx.document.activeLayer;
    const placement = this.makePlacement(target);
    if (!placement) return;
    // Grid blocks replace whatever occupies the cell; free placements stack.
    const displaced: Placement[] = [];
    if (placement.kind === "block") {
      const existing = this.ctx.document.findBlockAt(layer, placement.coord);
      if (existing) displaced.push(existing);
    }
    const cmd = new AddPlacementCmd(layer.id, placement, displaced);
    if (intoStroke) {
      cmd.execute(this.ctx.document);
      this.stroke.push(cmd);
    } else {
      this.ctx.history.run(cmd);
    }
  }

  private endStroke(): void {
    this.painting = false;
    this.lastPaintKey = null;
    if (this.stroke.length === 1) this.ctx.history.commit(this.stroke[0]);
    else if (this.stroke.length > 1)
      this.ctx.history.commit(new CompositeCmd(this.stroke, `Paint ${this.stroke.length} blocks`));
    this.stroke = [];
  }

  // --- keys ---

  onKeyDown(ev: KeyboardEvent): boolean | void {
    const k = ev.key.toLowerCase();
    if (k === "r") {
      this.dir = rotateDir(this.dir, 1);
      this.updateGhost();
      return true;
    }
    if ((k === "x" || k === "y" || k === "z") && this.armed) {
      const t = this.target(null);
      if (!t) return;
      if (this.constraint?.axis === k) {
        this.releaseConstraint();
        return true;
      }
      this.constraint = {
        axis: k as AxisName,
        anchorCell: t.cell,
        anchorPos: t.pos,
        yAccum: this.constraint?.axis === "y" ? this.constraint.yAccum : 0,
      };
      this.ctx.view.rig.suspended = true;
      this.ctx.ui.setHud([
        [k.toUpperCase(), `Place constrained to ${k.toUpperCase()}`],
        ["", "click place · right-click/Esc release"],
      ]);
      return true;
    }
    if (ev.key === "Escape" && this.constraint) {
      this.releaseConstraint();
      return true;
    }
  }

  private releaseConstraint(): void {
    if (!this.constraint) return;
    this.constraint = null;
    this.ctx.view.rig.suspended = false;
    this.ctx.ui.setHud(null);
    this.updateGhost();
  }

  // --- ghost ---

  private updateGhost(): void {
    if (!this.ghost) return;
    const t = this.target(null);
    if (!t) {
      this.ghost.visible = false;
      return;
    }
    const p = this.makePlacement(t);
    if (!p) return;
    const preview = this.ctx.renderer.buildObject(p);
    this.ghost.position.copy(preview.position);
    this.ghost.rotation.copy(preview.rotation);
    this.ghost.visible = true;
  }

  /** The ghost is a translucent clone of the armed block's template. */
  private refreshGhost(): void {
    this.dropGhost();
    if (!this.armed || this.ctx.tools.activeTool !== this) return;
    const def = this.ctx.catalog.get(this.armed);
    const obj = this.ctx.renderer.buildObject({
      id: "__ghost__",
      kind: "block",
      block: def?.name ?? this.armed,
      coord: [0, 0, 0],
      dir: this.dir,
    });
    obj.traverse((o) => {
      // Object3D.clone() shares materials with the template — clone before
      // dimming or every placed instance of this block would go translucent.
      // Real meshes carry material ARRAYS (one per usemtl group).
      type Mat = { clone(): { transparent: boolean; opacity: number } };
      const holder = o as { material?: Mat | Mat[] };
      if (!holder.material) return;
      const dim = (m: Mat) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.45;
        return c;
      };
      (holder as { material: unknown }).material = Array.isArray(holder.material)
        ? holder.material.map(dim)
        : dim(holder.material);
    });
    // Green plumb line from the ghost down to the layer floor, so the build
    // height is readable at a glance.
    const drop = this.ctx.tools.buildLevel * this.ctx.document.activeLayer.settings.gridStep[1];
    if (drop > 0) {
      const line = new Line(
        new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, -drop, 0)]),
        new LineBasicMaterial({ color: 0x35d07f }),
      );
      line.raycast = () => {};
      obj.add(line);
    }
    obj.visible = false;
    obj.name = "__ghost__";
    this.ghost = obj;
    // Parent to the active layer's group: the ghost inherits the layer's
    // transform and previews exactly on the plane the block will land on.
    const group = this.ctx.renderer.getLayerGroup(this.ctx.document.activeLayer.id);
    (group ?? this.ctx.view.scene).add(obj);
    this.updateGhost();
  }

  private dropGhost(): void {
    this.ghost?.removeFromParent();
    this.ghost = null;
  }
}
