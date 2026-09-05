import type { EditorContext } from "@plugins/api";
import { RemovePlacementCmd } from "@core/commands";
import type { Tool, ToolPointerEvent } from "./Tool";

/** Click (or drag) to remove placements. */
export class EraseTool implements Tool {
  readonly id = "erase";
  readonly label = "Erase";
  readonly hint = "Click or drag over blocks to remove them";

  private dragging = false;

  constructor(private ctx: EditorContext) {}

  onPointerDown(ev: ToolPointerEvent): void {
    this.dragging = true;
    this.eraseAt(ev);
  }

  onPointerMove(ev: ToolPointerEvent): void {
    if (this.dragging) this.eraseAt(ev);
  }

  onPointerUp(): void {
    this.dragging = false;
  }

  private eraseAt(ev: ToolPointerEvent): void {
    if (!ev.pick) return;
    const layer = this.ctx.document.getLayer(ev.pick.layerId);
    if (!layer || layer.locked) return;
    this.ctx.history.run(new RemovePlacementCmd(ev.pick.layerId, ev.pick.placementId, "Erase"));
  }
}
