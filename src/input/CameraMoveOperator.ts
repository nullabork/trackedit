import { Vector3 } from "three";
import type { EditorContext } from "@plugins/api";
import type { Operator } from "./Operator";
import type { AxisName } from "./frames";
import { axisVector, formatMeters, layerAxisWorld, mouseAlongAxis } from "./frames";

/**
 * `c x|y|z` / `c l x|y|z` — mouse slides the camera along one axis (global,
 * or the active layer's rotated frame) from where it currently is. Left
 * click locks the new position in; right click restores the old one.
 */
export class CameraMoveOperator implements Operator {
  private saved: Vector3;
  private axisWorld: Vector3;
  private delta = 0;

  constructor(
    private ctx: EditorContext,
    private axis: AxisName,
    private frame: "world" | "layer",
  ) {
    this.saved = ctx.view.rig.getPosition();
    // Layer frame is sampled once at operator start (spec: switching layers
    // mid-move changes nothing).
    this.axisWorld = frame === "layer"
      ? layerAxisWorld(axis, ctx.document.activeLayer.transform)
      : axisVector(axis);
  }

  hud(): Array<[string, string]> {
    const letters = this.frame === "layer"
      ? `C · L · ${this.axis.toUpperCase()}`
      : `C · ${this.axis.toUpperCase()}`;
    const words = this.frame === "layer"
      ? `Camera · layer ${this.axis.toUpperCase()}`
      : `Camera · global ${this.axis.toUpperCase()}`;
    return [[letters, words], ["", formatMeters(this.delta)]];
  }

  onPointerMove(dx: number, dy: number): void {
    const scale = Math.max(this.ctx.view.rig.focusDistance, 40) * 0.0016;
    this.delta += mouseAlongAxis(dx, dy, this.axisWorld, this.ctx.view.camera) * scale;
    this.ctx.view.rig.setPosition(
      this.saved.clone().addScaledVector(this.axisWorld, this.delta),
    );
  }

  onKey(): boolean {
    return false;
  }

  confirm(): void {
    // Position already applied.
  }

  cancel(): void {
    this.ctx.view.rig.setPosition(this.saved);
  }
}
