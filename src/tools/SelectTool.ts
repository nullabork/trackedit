import { Box3, Box3Helper, Color } from "three";
import type { EditorContext } from "@plugins/api";
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
    return `Click: select · Del: delete · ${this.ctx.view.rig.controls.scheme.translate.toUpperCase()}/R: move/rotate (modal)`;
  }

  private outlines: Box3Helper[] = [];

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
  }

  deactivate(): void {
    this.ctx.selection.clear();
  }

  onPointerDown(ev: ToolPointerEvent): void {
    if (ev.pick) {
      this.ctx.selection.set([
        { layerId: ev.pick.layerId, placementId: ev.pick.placementId },
      ]);
      const layer = this.ctx.document.getLayer(ev.pick.layerId);
      const p = layer?.placements.get(ev.pick.placementId);
      this.ctx.ui.setStatus(p ? `Selected ${p.block} — ${this.ctx.view.rig.controls.scheme.translate.toUpperCase()} translate, R rotate, Del delete` : "");
    } else {
      this.ctx.selection.clear();
    }
  }

  onKeyDown(ev: KeyboardEvent): boolean | void {
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
    for (const o of this.outlines) o.removeFromParent();
    this.outlines = [];
    for (const entry of this.ctx.selection.list) {
      const obj = this.ctx.renderer.getObject(entry.placementId);
      if (!obj) continue;
      const helper = new Box3Helper(new Box3(), new Color(0xffc83c));
      helper.userData.forPlacement = entry.placementId;
      this.ctx.view.scene.add(helper);
      this.outlines.push(helper);
    }
    this.syncOutlines();
  }

  /** Follows objects through layer-transform changes and modal previews. */
  private syncOutlines(): void {
    for (const helper of this.outlines) {
      const obj = this.ctx.renderer.getObject(helper.userData.forPlacement);
      if (obj) helper.box.setFromObject(obj);
    }
  }
}
