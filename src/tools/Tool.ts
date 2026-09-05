import type { Raycaster, Vector3 } from "three";
import type { GridCoord } from "@core/math";
import type { PickResult } from "@render/DocumentRenderer";

/** Pointer event enriched with everything a tool usually needs. */
export interface ToolPointerEvent {
  readonly native: PointerEvent;
  readonly ray: Raycaster;
  /** Intersection with the active build plane, in world metres (null when parallel). */
  readonly planeHit: Vector3 | null;
  /** The same intersection in the active layer's local space (un-floored). */
  readonly localHit: readonly [number, number, number] | null;
  /** planeHit snapped to the active layer's grid. */
  readonly cell: GridCoord | null;
  /** Placement under the cursor, if any. */
  readonly pick: PickResult | null;
}

/**
 * An editor tool (place, select, erase, ...). Tools are registered via the
 * plugin API; built-in tools use the same interface as third-party ones.
 */
export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Short hint shown in the status bar while active. */
  readonly hint?: string;
  activate?(): void;
  deactivate?(): void;
  onPointerDown?(ev: ToolPointerEvent): void;
  onPointerMove?(ev: ToolPointerEvent): void;
  onPointerUp?(ev: ToolPointerEvent): void;
  /** Right button pressed (fires alongside camera fly unless the rig is suspended). */
  onRightDown?(ev: ToolPointerEvent): void;
  /** Quick right CLICK (short press, no drag) — never fires for a hold-to-fly. */
  onRightClick?(ev: ToolPointerEvent): void;
  onKeyDown?(ev: KeyboardEvent): boolean | void;
}
