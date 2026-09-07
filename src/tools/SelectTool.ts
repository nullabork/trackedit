import { Box3 } from "three";
import type { EditorContext } from "@plugins/api";
import { SelectionBox } from "@render/selectionBox";
import type { Axis } from "@render/selectionBox";
import { TransformOperator } from "@input/TransformOperator";
import { RemovePlacementCmd, CompositeCmd } from "@core/commands";
import type { Command } from "@core/commands";
import type { Tool, ToolPointerEvent } from "./Tool";

/**
 * Click to select a placement (shared SelectionModel — modal operators like
 * `t`/`r` act on it); click empty space to clear; Delete removes.
 */
export class SelectTool implements Tool {
  readonly id = "select";
  readonly label = "Select";
  get hint(): string {
    return `Click: select · Shift+click: add/remove · drag a tag: move along it, its ring: rotate · Del: delete · ${this.ctx.view.rig.controls.scheme.translate.toUpperCase()}/R: move/rotate (modal)`;
  }

  private outlines: SelectionBox[] = [];
  private readonly box = new Box3();
  /** Live handle drag: a translate (tag) or rotate (ring) operator on one axis. */
  private drag: { op: TransformOperator; axis: Axis } | null = null;

  constructor(private ctx: EditorContext) {
    ctx.document.events.on("placementRemoved", ({ placement }) => {
      // ReplacePlacementCmd removes and re-adds the same id synchronously —
      // only drop the selection if the placement is really gone.
      queueMicrotask(() => {
        if (!this.ctx.renderer.getObject(placement.id))
          this.ctx.selection.remove(placement.id);
        else this.syncOutlines();
      });
    });
    ctx.selection.events.on("changed", () => this.rebuildOutlines());
    ctx.view.onFrame(() => this.syncOutlines());
    ctx.view.onRenderPrefsChanged((p) => {
      for (const o of this.outlines) o.setColors(p);
    });
  }

  deactivate(): void {
    this.endDrag(false);
    if (this.ctx.view.canvas) this.ctx.view.canvas.style.cursor = "";
    this.ctx.selection.clear();
  }

  onPointerDown(ev: ToolPointerEvent): void {
    // Grab an axis tag of the selection box: move the selection along that
    // axis while the button is held. The operator applies the placement
    // constraint mode (grid snap vs free) like the T sequence does.
    if (ev.ray && this.outlines.length) ev.ray.camera = this.ctx.view.camera;
    for (const outline of ev.ray ? this.outlines : []) {
      const ring = outline.hitRing(ev.ray);
      const tag = ring ? null : outline.hitTag(ev.ray);
      if (!ring && !tag) continue;
      const op = new TransformOperator(this.ctx, ring ? "rotate" : "translate");
      if (!op.hasTargets) return;
      const axis = ring ? SelectionBox.rotationAxisOf(ring) : tag!;
      op.setAxes([axis]);
      this.drag = { op, axis };
      this.ctx.view.rig.suspended = true;
      this.ctx.ui.setHud(op.hud());
      return;
    }
    const additive = ev.native.shiftKey;
    if (ev.pick) {
      const entry = { layerId: ev.pick.layerId, placementId: ev.pick.placementId };
      // Shift toggles membership so a set can be built up (or trimmed)
      // click by click; a plain click starts over with just this one.
      if (additive) this.ctx.selection.toggle(entry);
      else this.ctx.selection.set([entry]);
    } else if (!additive) {
      this.ctx.selection.clear();
    }
    const entries = this.ctx.selection.list;
    const entry = entries[0];
    const p = entry && this.ctx.document.getLayer(entry.layerId)?.placements.get(entry.placementId);
    const shortcuts = `${this.ctx.view.rig.controls.scheme.translate.toUpperCase()} translate, R rotate, Del delete`;
    this.ctx.ui.setStatus(
      entries.length > 1 ? `${entries.length} selected — ${shortcuts}` :
      p ? `Selected ${p.block} — ${shortcuts}` : "");
  }

  onPointerMove(ev: ToolPointerEvent): void {
    const canvas = this.ctx.view.canvas;
    if (!canvas) return;
    if (this.drag) {
      canvas.style.cursor = "grabbing";
      this.drag.op.onPointerMove(ev.native.movementX, ev.native.movementY);
      this.ctx.ui.setHud(this.drag.op.hud());
      return;
    }
    // Hover feedback: a grab hand over the box's handles, a pointer over a
    // block (click selects it, or deselects on empty space).
    let overHandle = false;
    if (ev.ray && this.outlines.length) {
      ev.ray.camera = this.ctx.view.camera;
      overHandle = this.outlines.some((o) => o.hitRing(ev.ray) || o.hitTag(ev.ray));
    }
    canvas.style.cursor = overHandle ? "grab" : ev.pick ? "pointer" : "";
  }

  onPointerUp(): void {
    this.endDrag(true);
  }

  private endDrag(commit: boolean): void {
    if (!this.drag) return;
    if (commit) this.drag.op.confirm();
    else this.drag.op.cancel();
    this.drag = null;
    this.ctx.view.rig.suspended = false;
    this.ctx.ui.setHud(null);
    if (this.ctx.view.canvas) this.ctx.view.canvas.style.cursor = "grab";
  }

  onKeyDown(ev: KeyboardEvent): boolean | void {
    if (this.drag && ev.key === "Escape") {
      this.endDrag(false);
      return true;
    }
    if (this.ctx.selection.isEmpty) return;
    if (ev.key === "Delete" || ev.key === "Backspace" ||
        (this.ctx.view.rig.controls.id !== "trackedit" && ev.key.toLowerCase() === "x")) {
      const cmds: Command[] = this.ctx.selection.list.map(
        (e) => new RemovePlacementCmd(e.layerId, e.placementId, "Delete selection"),
      );
      this.ctx.history.run(
        cmds.length === 1 ? cmds[0] : new CompositeCmd(cmds, "Delete selection"),
      );
      return true;
    }
  }

  private rebuildOutlines(): void {
    for (const o of this.outlines) {
      o.removeFromParent();
      o.dispose();
    }
    this.outlines = [];
    for (const entry of this.ctx.selection.list) {
      const obj = this.ctx.renderer.getObject(entry.placementId);
      if (!obj) continue;
      const helper = new SelectionBox(this.ctx.view.getRenderPrefs());
      helper.userData.forPlacement = entry.placementId;
      this.ctx.view.scene.add(helper);
      this.outlines.push(helper);
    }
    this.syncOutlines();
  }

  /** Follows objects through layer-transform changes and modal previews. */
  private syncOutlines(): void {
    const camPos = this.ctx.view.camera.position;
    for (const helper of this.outlines) {
      const obj = this.ctx.renderer.getObject(helper.userData.forPlacement);
      if (!obj) continue;
      helper.setBox(this.box.setFromObject(obj));
      helper.updateForCamera(camPos);
    }
  }
}
