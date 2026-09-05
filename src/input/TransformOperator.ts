import { Euler, Object3D, Quaternion, Vector3 } from "three";
import type { EditorContext } from "@plugins/api";
import type { Layer, Placement } from "@core/layer";
import type { Command } from "@core/commands";
import { CompositeCmd, ReplacePlacementCmd, UpdateLayerCmd } from "@core/commands";
import type { Dir, GridCoord } from "@core/math";
import { CELL, clampCoord, degToRad, radToDeg, rotateDir } from "@core/math";
import type { Operator } from "./Operator";
import type { AxisName } from "./frames";
import {
  axisVector,
  formatDegrees,
  formatMeters,
  mouseAlongAxis,
  worldToLayerDelta,
} from "./frames";

interface PlacementTarget {
  layer: Layer;
  placement: Placement;
  obj: Object3D;
  origPos: Vector3;
  origQuat: Quaternion;
}

interface LayerTarget {
  layer: Layer;
  group: Object3D;
  origTranslate: Vector3;
  origQuat: Quaternion;
  /** World-space pivot: centre of the layer's content (or the map centre). */
  pivot: Vector3;
}

/**
 * `t` / `r` modal transforms (docs/SPEC-sequence-shortcuts.md §3, §5).
 *
 * Two target modes, toggled with `l`:
 * - placements: the current selection. Translate snaps to each piece's own
 *   layer grid; rotate uses the piece's personal frame (grid blocks snap to
 *   quarter turns on Y; pitch/roll converts them to free blocks).
 * - layer: the selection's layer(s) — or the active layer when nothing is
 *   selected, in which case `t`/`r` starts in layer mode directly. Moves or
 *   spins the whole layer plane (rotation is Y-only for now: the layer
 *   transform model has no tilt yet).
 *
 * Previews only touch three.js objects/groups; the document changes once,
 * on confirm, as a single undoable command. Digits switch to exact numeric
 * input (Backspace edits, Enter/click commits, Esc/right-click restores).
 */
export class TransformOperator implements Operator {
  private placementTargets: PlacementTarget[] = [];
  private layerTargets: LayerTarget[] = [];
  private onLayers: boolean;
  private axes: AxisName[] = [];
  private typed = "";
  private accX = 0;
  private accY = 0;

  constructor(
    private ctx: EditorContext,
    private mode: "translate" | "rotate",
  ) {
    for (const entry of ctx.selection.list) {
      const layer = ctx.document.getLayer(entry.layerId);
      const placement = layer?.placements.get(entry.placementId);
      const obj = ctx.renderer.getObject(entry.placementId);
      if (!layer || !placement || !obj) continue;
      this.placementTargets.push({
        layer,
        placement,
        obj,
        origPos: obj.position.clone(),
        origQuat: obj.quaternion.clone(),
      });
    }
    // Nothing selected: operate on the active layer itself.
    this.onLayers = this.placementTargets.length === 0;
    if (this.onLayers) this.buildLayerTargets();
  }

  get hasTargets(): boolean {
    return this.placementTargets.length > 0 || this.layerTargets.length > 0;
  }

  private buildLayerTargets(): void {
    if (this.layerTargets.length > 0) return;
    const layers = this.placementTargets.length > 0
      ? [...new Set(this.placementTargets.map((t) => t.layer))]
      : [this.ctx.document.activeLayer];
    for (const layer of layers) {
      const group = this.ctx.renderer.getLayerGroup(layer.id);
      if (!group) continue;
      group.updateMatrixWorld();
      this.layerTargets.push({
        layer,
        group,
        origTranslate: group.position.clone(),
        origQuat: group.quaternion.clone(),
        pivot: this.layerPivotWorld(layer, group),
      });
    }
  }

  /** Rotation pivot: centre of the layer's placements, or the map centre. */
  private layerPivotWorld(_layer: Layer, group: Object3D): Vector3 {
    let min: Vector3 | null = null;
    let max: Vector3 | null = null;
    for (const child of group.children) {
      if (!child.userData.placementId) continue; // skip the plane outline
      if (!min || !max) {
        min = child.position.clone();
        max = child.position.clone();
      } else {
        min.min(child.position);
        max.max(child.position);
      }
    }
    const size = this.ctx.document.size;
    const local = min && max
      ? min.add(max).multiplyScalar(0.5)
      : new Vector3((size[0] * CELL[0]) / 2, 0, (size[2] * CELL[2]) / 2);
    return group.localToWorld(local);
  }

  // --- HUD ---

  hud(): Array<[string, string]> {
    const letters: string[] = [this.mode === "translate" ? "T" : "R"];
    const words: string[] = [this.mode === "translate" ? "Translate" : "Rotate"];
    if (this.onLayers) {
      letters.push("L");
      const names = this.layerTargets.map((t) => t.layer.name).join(", ");
      words.push(`layer ${names}`);
    }
    for (const a of this.axes) {
      letters.push(a.toUpperCase());
      words.push(`${this.onLayers ? "world" : this.mode === "rotate" ? "personal" : "global"} ${a.toUpperCase()}`);
    }
    let value: string;
    if (this.typed !== "") {
      value = this.typed + (this.mode === "translate" ? " m" : " °");
    } else if (this.mode === "translate") {
      value = formatMeters(this.currentScalar());
    } else {
      value = formatDegrees(this.currentScalar());
    }
    return [[letters.join(" · "), words.join(" · ")], ["", value]];
  }

  // --- input ---

  onPointerMove(dx: number, dy: number): void {
    if (this.typed !== "") return; // typed input overrides the mouse
    this.accX += dx;
    this.accY += dy;
    this.applyPreview();
  }

  onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === "x" || k === "y" || k === "z") {
      if (this.axes.includes(k)) this.axes = this.axes.filter((a) => a !== k);
      else if (this.mode === "rotate" || this.axes.length >= 2) this.axes = [k];
      else this.axes.push(k);
      this.applyPreview();
      return true;
    }
    if (k === "l") {
      // Switch target: placements <-> their layer(s). The abandoned mode's
      // preview is restored so only one thing moves at a time.
      if (this.placementTargets.length === 0) return true; // already layer-only
      this.restorePreviews();
      this.onLayers = !this.onLayers;
      if (this.onLayers) this.buildLayerTargets();
      this.accX = this.accY = 0;
      this.typed = "";
      return true;
    }
    if (/^[0-9]$/.test(e.key) || e.key === ".") {
      this.typed += e.key;
      this.applyPreview();
      return true;
    }
    if (e.key === "-") {
      this.typed = this.typed.startsWith("-") ? this.typed.slice(1) : "-" + this.typed;
      this.applyPreview();
      return true;
    }
    if (e.key === "Backspace") {
      this.typed = this.typed.slice(0, -1);
      this.applyPreview();
      return true;
    }
    return false;
  }

  // --- lifecycle ---

  confirm(): void {
    const cmds: Command[] = [];
    if (this.onLayers) {
      for (const t of this.layerTargets) {
        const cmd = this.commitLayer(t);
        if (cmd) cmds.push(cmd);
      }
    } else {
      for (const t of this.placementTargets) {
        const next = this.commitPlacement(t);
        if (next) cmds.push(new ReplacePlacementCmd(t.layer.id, next, this.label()));
      }
    }
    // Commands rebuild the visuals; drop previews first so cancel-state never leaks.
    this.restorePreviews();
    if (cmds.length === 1) this.ctx.history.run(cmds[0]);
    else if (cmds.length > 1) this.ctx.history.run(new CompositeCmd(cmds, this.label()));
  }

  cancel(): void {
    this.restorePreviews();
  }

  private label(): string {
    const what = this.onLayers ? "layer" : "selection";
    return this.mode === "translate" ? `Translate ${what}` : `Rotate ${what}`;
  }

  private restorePreviews(): void {
    for (const t of this.placementTargets) {
      t.obj.position.copy(t.origPos);
      t.obj.quaternion.copy(t.origQuat);
    }
    for (const t of this.layerTargets) {
      t.group.position.copy(t.origTranslate);
      t.group.quaternion.copy(t.origQuat);
    }
  }

  // --- shared value derivation ---

  private typedValue(): number | null {
    if (this.typed === "") return null;
    const v = parseFloat(this.typed);
    return Number.isFinite(v) ? v : 0;
  }

  /** Scalar shown in the HUD (axis translate metres, or rotation degrees). */
  private currentScalar(): number {
    const typed = this.typedValue();
    if (typed !== null) return typed;
    if (this.mode === "rotate") return this.accX * 0.4;
    const axis = axisVector(this.axes[0] ?? "x");
    return mouseAlongAxis(this.accX, this.accY, axis, this.ctx.view.camera) * this.metersPerPixel();
  }

  private metersPerPixel(): number {
    const ref = this.onLayers
      ? this.layerTargets[0]?.group.getWorldPosition(new Vector3())
      : this.placementTargets[0]?.obj.getWorldPosition(new Vector3());
    return Math.max(this.ctx.view.camera.position.distanceTo(ref ?? new Vector3()), 40) * 0.0016;
  }

  // --- translate ---

  /** World-space offset before snapping (axes are world axes). */
  private worldOffset(): Vector3 {
    const typed = this.typedValue();
    if (typed !== null && this.axes.length >= 1)
      return axisVector(this.axes[0]).multiplyScalar(typed);

    const mpp = this.metersPerPixel();
    if (this.axes.length === 1) {
      const axis = axisVector(this.axes[0]);
      const s = mouseAlongAxis(this.accX, this.accY, axis, this.ctx.view.camera) * mpp;
      return axis.multiplyScalar(s);
    }

    // Free / plane drag: move in the camera plane...
    const cam = this.ctx.view.camera;
    const right = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const free = right.multiplyScalar(this.accX * mpp).addScaledVector(up, -this.accY * mpp);
    if (this.axes.length === 2) {
      // ...then keep only the two allowed axes' components.
      const excluded = (["x", "y", "z"] as AxisName[]).find((a) => !this.axes.includes(a))!;
      const ex = axisVector(excluded);
      free.addScaledVector(ex, -free.dot(ex));
    }
    return free;
  }

  private snapToStep(v: Vector3, layer: Layer): Vector3 {
    if (this.typedValue() !== null) return v; // typed values are exact
    const step = layer.settings.gridStep;
    v.x = Math.round(v.x / step[0]) * step[0];
    v.y = Math.round(v.y / step[1]) * step[1];
    v.z = Math.round(v.z / step[2]) * step[2];
    return v;
  }

  /** Layer-local, grid-snapped delta for one placement target. */
  private layerDelta(t: PlacementTarget): Vector3 {
    const local = worldToLayerDelta(this.worldOffset(), t.layer.transform);
    return this.snapToStep(local, t.layer);
  }

  /** Rotated layer state for preview/commit: quaternion + pivot-compensated position. */
  private layerRotation(t: LayerTarget): { quat: Quaternion; position: Vector3 } {
    const theta = -degToRad(this.rotationDeg(false)); // positive = clockwise from above
    const qd = new Quaternion().setFromAxisAngle(axisVector(this.rotationAxis()), theta);
    // Rotate about the pivot: T' = P + qΔ·(T − P), R' = qΔ·R.
    const position = t.origTranslate.clone().sub(t.pivot).applyQuaternion(qd).add(t.pivot);
    return { quat: qd.multiply(t.origQuat), position };
  }

  // --- rotate ---

  /**
   * Typed angles are exact; mouse-driven rotation snaps — quarter turns for a
   * grid block yawing (so it stays on the grid), 15° otherwise.
   */
  private rotationDeg(snapQuarters: boolean): number {
    const typed = this.typedValue();
    if (typed !== null) return typed;
    const raw = this.accX * 0.4;
    return snapQuarters ? Math.round(raw / 90) * 90 : Math.round(raw / 15) * 15;
  }

  private rotationAxis(): AxisName {
    return this.axes[0] ?? "y";
  }

  // --- preview ---

  private applyPreview(): void {
    if (this.onLayers) {
      for (const t of this.layerTargets) {
        if (this.mode === "translate") {
          const off = this.snapToStep(this.worldOffset(), t.layer);
          t.group.position.copy(t.origTranslate).add(off);
        } else {
          const { quat, position } = this.layerRotation(t);
          t.group.quaternion.copy(quat);
          t.group.position.copy(position);
        }
      }
      return;
    }

    for (const t of this.placementTargets) {
      if (this.mode === "translate") {
        t.obj.position.copy(t.origPos).add(this.layerDelta(t));
        continue;
      }
      const axis = this.rotationAxis();
      const isBlock = t.placement.kind === "block";
      const theta = -degToRad(this.rotationDeg(isBlock && axis === "y")); // positive = clockwise from above
      const q = new Quaternion().setFromAxisAngle(axisVector(axis), theta);
      // Personal frame: rotate about the object's own axis (a road piece
      // pitches along its own direction).
      t.obj.quaternion.copy(t.origQuat.clone().multiply(q));
    }
  }

  // --- commit ---

  private commitLayer(t: LayerTarget): Command | null {
    if (this.mode === "translate") {
      const off = this.snapToStep(this.worldOffset(), t.layer);
      if (off.lengthSq() < 1e-9) return null;
      const p = t.origTranslate.clone().add(off);
      return new UpdateLayerCmd(
        t.layer.id,
        {
          transform: {
            translate: [p.x, p.y, p.z],
            rotDeg: [...t.layer.transform.rotDeg] as [number, number, number],
          },
        },
        this.label(),
      );
    }
    if (this.rotationDeg(false) === 0) return null;
    const { quat, position } = this.layerRotation(t);
    const e = new Euler().setFromQuaternion(quat, "YXZ");
    return new UpdateLayerCmd(
      t.layer.id,
      {
        transform: {
          translate: [position.x, position.y, position.z],
          rotDeg: [radToDeg(e.x), radToDeg(e.y), radToDeg(e.z)],
        },
      },
      this.label(),
    );
  }

  private commitPlacement(t: PlacementTarget): Placement | null {
    const p = t.placement;
    if (this.mode === "translate") {
      const delta = this.layerDelta(t);
      if (delta.lengthSq() < 1e-9) return null;
      if (p.kind === "block") {
        const step = t.layer.settings.gridStep;
        const cells: GridCoord = [
          p.coord[0] + Math.round(delta.x / step[0]),
          p.coord[1] + Math.round(delta.y / step[1]),
          p.coord[2] + Math.round(delta.z / step[2]),
        ];
        const clamped = clampCoord(cells, this.ctx.document.size);
        if (clamped.every((v, i) => v === p.coord[i])) return null;
        return { ...p, coord: clamped };
      }
      return { ...p, pos: [p.pos[0] + delta.x, p.pos[1] + delta.y, p.pos[2] + delta.z] };
    }

    const axis = this.rotationAxis();
    const deg = this.rotationDeg(p.kind === "block" && axis === "y");
    if (deg === 0) return null;
    if (p.kind === "block") {
      // Pure quarter-turn yaw stays on the grid via `dir`...
      if (axis === "y" && Math.abs(deg % 90) < 1e-6)
        return { ...p, dir: rotateDir(p.dir, Math.round(deg / 90)) as Dir };
      // ...anything else can't live on the game grid: convert to a free
      // block (absPos points at the footprint's min corner, see renderer).
      const off = (t.obj.userData.originOffset as [number, number, number]) ?? [0, 0, 0];
      const origin = new Vector3(...off).applyQuaternion(t.obj.quaternion).add(t.obj.position);
      const e = new Euler().setFromQuaternion(t.obj.quaternion, "YXZ");
      return {
        id: p.id,
        kind: "free",
        block: p.block,
        pos: [origin.x, origin.y, origin.z],
        rot: [e.y, e.x, e.z],
        isItem: false,
        meta: p.meta,
      };
    }
    // Free placement: read the previewed quaternion back into yaw/pitch/roll.
    const e = new Euler().setFromQuaternion(t.obj.quaternion, "YXZ");
    return { ...p, rot: [e.y, e.x, e.z] };
  }
}
