import type { EditorContext } from "@plugins/api";
import { CompositeCmd, ReplacePlacementCmd } from "@core/commands";
import type { Command } from "@core/commands";
import type { Placement } from "@core/layer";
import type { Tool, ToolPointerEvent } from "./Tool";

export const PAINTABLE = ["Default", "White", "Green", "Blue", "Red", "Black"] as const;
export type PaintColor = (typeof PAINTABLE)[number];

/**
 * Block color painting, like the game's paint mode: click (or drag across)
 * placements to set their color. The color rides in placement.meta.color,
 * so it round-trips to .Map.Gbx unchanged; only the game's repaintable
 * (HueMask) surfaces tint in the render. One drag = one undo step.
 */
export class PaintTool implements Tool {
  readonly id = "paint";
  readonly label = "Paint";

  color: PaintColor = "White";

  private dragging = false;
  private stroke: Command[] = [];
  private done = new Set<string>();

  constructor(private ctx: EditorContext) {}

  get hint(): string {
    return `Paint: ${this.color} — click/drag over blocks · pick a color in the swatch`;
  }

  setColor(color: PaintColor): void {
    this.color = color;
    this.ctx.events.emit("paintColorChanged", { color });
    this.ctx.ui.setStatus(this.hint);
  }

  onPointerDown(ev: ToolPointerEvent): void {
    this.dragging = true;
    this.stroke = [];
    this.done.clear();
    this.paintAt(ev);
  }

  onPointerMove(ev: ToolPointerEvent): void {
    if (this.dragging) this.paintAt(ev);
  }

  onPointerUp(): void {
    this.dragging = false;
    this.commitStroke();
  }

  deactivate(): void {
    this.dragging = false;
    this.commitStroke();
  }

  private paintAt(ev: ToolPointerEvent): void {
    const pick = ev.pick;
    if (!pick) return;
    const layer = this.ctx.document.getLayer(pick.layerId);
    if (!layer || layer.locked) return;
    const p = layer.placements.get(pick.placementId);
    if (!p || this.done.has(p.id)) return;
    this.done.add(p.id);
    const current = (p.meta as { color?: string } | undefined)?.color ?? "Default";
    if (current === this.color) return;
    const next = { ...p, meta: { ...(p.meta ?? {}), color: this.color } } as Placement;
    const cmd = new ReplacePlacementCmd(pick.layerId, next, `Paint ${this.color}`);
    cmd.execute(this.ctx.document);
    this.stroke.push(cmd);
  }

  private commitStroke(): void {
    if (this.stroke.length === 1) this.ctx.history.commit(this.stroke[0]);
    else if (this.stroke.length > 1)
      this.ctx.history.commit(
        new CompositeCmd(this.stroke, `Paint ${this.stroke.length} blocks ${this.color}`),
      );
    this.stroke = [];
  }
}
