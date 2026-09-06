import { blocksEditorInput, dragAction, flyShortcut, wheelAction } from "@input/ControlScheme";
import { Emitter } from "@core/events";
import type { MapDocument } from "@core/document";
import { clampCoord } from "@core/math";
import type { GridCoord } from "@core/math";
import type { SceneView } from "@render/SceneView";
import type { DocumentRenderer } from "@render/DocumentRenderer";
import type { Tool, ToolPointerEvent } from "./Tool";

export interface ToolManagerEvents extends Record<string, unknown> {
  activeChanged: { tool: Tool | null };
  registered: { tool: Tool };
  /** The build height (grid Y level) changed. */
  buildLevelChanged: { level: number };
}

/**
 * Registry + dispatcher. Owns the pointer/keyboard wiring to the canvas and
 * translates raw events into ToolPointerEvents (ray, plane hit, grid cell,
 * pick) so each tool stays tiny.
 */
/**
 * Something that gets first refusal on raw input — the sequence-shortcut
 * engine. A consumed event never reaches tools or build-level keys.
 */
export interface InputInterceptor {
  handleKey(e: KeyboardEvent): boolean;
  handlePointerDown(e: PointerEvent): boolean;
  handlePointerMove(e: PointerEvent): boolean;
}

export class ToolManager {
  readonly events = new Emitter<ToolManagerEvents>();
  private tools = new Map<string, Tool>();
  private active: Tool | null = null;
  private interceptor: InputInterceptor | null = null;
  private lastPointer: PointerEvent | null = null;
  private rightDownAt: { t: number; moved: number } | null = null;
  /** Current build Y level in cells. */
  buildLevel = 0;

  setInterceptor(i: InputInterceptor): void {
    this.interceptor = i;
  }

  constructor(
    private doc: MapDocument,
    private view: SceneView,
    private renderer: DocumentRenderer,
  ) {
    const canvas = view.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      if (view.rig.isFlying) return; // clicks land the fly, never place blocks
      if (this.interceptor?.handlePointerDown(e)) return;
      if (view.rig.isNavigating || (!view.rig.suspended && dragAction(view.rig.controls.id, e) === "pan")) return;
      if (e.button === 0) this.active?.onPointerDown?.(this.enrich(e));
      else if (e.button === 2) {
        this.rightDownAt = { t: performance.now(), moved: 0 };
        this.active?.onRightDown?.(this.enrich(e));
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      this.lastPointer = e;
      if (this.rightDownAt)
        this.rightDownAt.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (view.rig.isNavigating) return;
      if (this.interceptor?.handlePointerMove(e)) return;
      this.active?.onPointerMove?.(this.enrich(e));
    });
    canvas.addEventListener("pointerup", (e) => {
      if (e.button === 0) this.active?.onPointerUp?.(this.enrich(e));
      else if (e.button === 2 && this.rightDownAt) {
        // A quick, still right-press is a CLICK; a longer or dragged press is
        // the camera's hold-to-fly and must not reach the tool. Movement is
        // accumulated from movementX/Y so pointer lock can't fool the test.
        const d = this.rightDownAt;
        this.rightDownAt = null;
        if (performance.now() - d.t < 350 && d.moved < 8)
          this.active?.onRightClick?.(this.enrich(e));
      }
    });
    canvas.addEventListener("pointercancel", () => { this.rightDownAt = null; });
    view.rig.controls.events.on("changed", () => { this.rightDownAt = null; });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Resolve wheel ownership from the same preset as CameraRig.
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (view.rig.suspended || view.rig.isFlying || wheelAction(view.rig.controls.id, e) !== "height") return;
        e.preventDefault();
        this.setBuildLevel(this.buildLevel - Math.sign(e.deltaY));
      },
      { passive: false },
    );

    window.addEventListener("keydown", (e) => {
      if (blocksEditorInput(e.target)) return;
      if (view.rig.isFlying) {
        if ((!e.repeat && flyShortcut(view.rig.controls.id, e)) || e.key === "Escape") {
          e.preventDefault();
          view.rig.resetInput();
        }
        return;
      }
      if (this.interceptor?.handleKey(e)) {
        // A consumed key must not double as flight input (`c` = sequence
        // prefix AND descend).
        e.preventDefault();
        view.rig.clearKey(e.code);
        return;
      }
      if (flyShortcut(view.rig.controls.id, e) && !e.repeat) {
        e.preventDefault();
        view.rig.toggleFly();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.active?.onKeyDown?.(e)) e.preventDefault();
    });
  }

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
    this.events.emit("registered", { tool });
  }

  get all(): Tool[] {
    return [...this.tools.values()];
  }

  get activeTool(): Tool | null {
    return this.active;
  }

  setActive(id: string): void {
    const tool = this.tools.get(id) ?? null;
    if (tool === this.active) return;
    this.active?.deactivate?.();
    this.active = tool;
    tool?.activate?.();
    this.events.emit("activeChanged", { tool });
  }

  setBuildLevel(level: number): void {
    const clamped = Math.min(Math.max(level, 0), this.doc.size[1] - 1);
    if (clamped === this.buildLevel) return;
    this.buildLevel = clamped;
    this.events.emit("buildLevelChanged", { level: clamped });
    // Re-track the pointer so ghosts follow a height change immediately,
    // without waiting for the next mouse move.
    if (this.lastPointer) this.active?.onPointerMove?.(this.enrich(this.lastPointer));
  }

  /**
   * Build plane sits at the current level in the *active layer's* frame —
   * layers are independent planes with arbitrary rotation, so the ray is
   * intersected in layer-local space using the layer group's own matrix.
   */
  private enrich(native: PointerEvent): ToolPointerEvent {
    const ray = this.view.rayFromEvent(native);
    const layer = this.doc.activeLayer;
    const step = layer.settings.gridStep;

    let cell: GridCoord | null = null;
    let hit = null;
    let localHit: readonly [number, number, number] | null = null;
    const group = this.renderer.getLayerGroup(layer.id);
    if (group) {
      group.updateMatrixWorld();
      const inv = group.matrixWorld.clone().invert();
      const origin = ray.ray.origin.clone().applyMatrix4(inv);
      const dir = ray.ray.direction.clone().transformDirection(inv);
      const planeY = this.buildLevel * step[1];
      if (Math.abs(dir.y) > 1e-6) {
        const t = (planeY - origin.y) / dir.y;
        if (t >= 0) {
          const local = origin.addScaledVector(dir, t);
          localHit = [local.x, local.y, local.z];
          hit = local.clone().applyMatrix4(group.matrixWorld);
          cell = clampCoord(
            [Math.floor(local.x / step[0]), this.buildLevel, Math.floor(local.z / step[2])],
            this.doc.size,
          );
        }
      }
    }

    // Picking raycasts the whole scene — expensive on big maps — so it's
    // lazy: tools that never read `pick` (PlaceTool) never pay for it.
    const ev = { native, ray, planeHit: hit, localHit, cell } as ToolPointerEvent;
    let pick: ReturnType<DocumentRenderer["pick"]> | undefined;
    Object.defineProperty(ev, "pick", {
      get: () => (pick !== undefined ? pick : (pick = this.renderer.pick(ray))),
    });
    return ev;
  }
}
