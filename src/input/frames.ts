import { Euler, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { degToRad } from "@core/math";
import type { LayerTransform } from "@core/layer";

/**
 * Frame/axis helpers for modal operators (see docs/SPEC-sequence-shortcuts.md).
 * Layer rotation is a full Euler YXZ in degrees, three.js conventions —
 * must stay in lockstep with DocumentRenderer.syncLayerGroup.
 */

export type AxisName = "x" | "y" | "z";

export function layerQuaternion(t: LayerTransform): Quaternion {
  return new Quaternion().setFromEuler(
    new Euler(degToRad(t.rotDeg[0]), degToRad(t.rotDeg[1]), degToRad(t.rotDeg[2]), "YXZ"),
  );
}

export function axisVector(axis: AxisName): Vector3 {
  switch (axis) {
    case "x": return new Vector3(1, 0, 0);
    case "y": return new Vector3(0, 1, 0);
    case "z": return new Vector3(0, 0, 1);
  }
}

/** A layer-frame axis expressed in world space. */
export function layerAxisWorld(axis: AxisName, t: LayerTransform): Vector3 {
  return axisVector(axis).applyQuaternion(layerQuaternion(t));
}

/** World-space delta -> layer-local delta (rotation only, deltas ignore translation). */
export function worldToLayerDelta(v: Vector3, t: LayerTransform): Vector3 {
  return v.clone().applyQuaternion(layerQuaternion(t).invert());
}

/**
 * Screen-space direction (x right, y down, normalized) that a world-space
 * axis appears to point in, or null when it points into the screen.
 */
export function screenDirection(axisWorld: Vector3, camera: PerspectiveCamera): { x: number; y: number } | null {
  const view = axisWorld.clone().applyQuaternion(camera.quaternion.clone().invert());
  const len = Math.hypot(view.x, view.y);
  if (len < 1e-4) return null;
  return { x: view.x / len, y: -view.y / len };
}

/** Mouse movement (px) projected onto a world axis' screen direction. */
export function mouseAlongAxis(
  dx: number,
  dy: number,
  axisWorld: Vector3,
  camera: PerspectiveCamera,
): number {
  const dir = screenDirection(axisWorld, camera) ?? { x: 0, y: -1 };
  return dx * dir.x + dy * dir.y;
}

export function formatMeters(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)} m`;
}

export function formatDegrees(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(0)}°`;
}
