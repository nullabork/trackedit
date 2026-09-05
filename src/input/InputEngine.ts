import type { EditorContext } from "@plugins/api";
import type { Operator } from "./Operator";
import type { AxisName } from "./frames";
import { CameraMoveOperator } from "./CameraMoveOperator";
import { TransformOperator } from "./TransformOperator";

/**
 * Sequence-shortcut engine (docs/SPEC-sequence-shortcuts.md): builds chorded
 * key sequences (`c` `l` `y`, `t` `x` `-` `9` `9`) into modal operators,
 * drives the viewport HUD, and owns the mouse while an operator is active.
 *
 * ToolManager consults this first for every key/pointer event; while an
 * operator runs, tools and the camera rig are suspended.
 */
export class InputEngine {
  private prefix: string[] = [];
  private op: Operator | null = null;

  constructor(private ctx: EditorContext) {}

  get modal(): boolean {
    return this.op !== null;
  }

  /** Returns true when the event was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (this.op) {
      if (e.key === "Enter") return this.finish(true), true;
      if (e.key === "Escape") return this.finish(false), true;
      if (this.op.onKey(e)) {
        this.refreshHud();
        return true;
      }
      return true; // modal swallows everything else
    }

    const k = e.key.toLowerCase();
    if (this.prefix.length === 0) {
      if (k === "c") {
        this.prefix = ["c"];
        this.showPrefixHud();
        return true;
      }
      if (k === "t" || k === "r") {
        this.startTransform(k === "t" ? "translate" : "rotate");
        return true;
      }
      // Tool shortcuts. `s` stays free for WASD flying (S = backward).
      if (k === "e") {
        this.ctx.tools.setActive("select");
        return true;
      }
      if (k === "p") {
        // P enters place mode; pressed again it toggles grid <-> free place.
        const active = this.ctx.tools.activeTool;
        if (active?.id === "place" && "toggleMode" in active)
          (active as { toggleMode(): void }).toggleMode();
        else this.ctx.tools.setActive("place");
        return true;
      }
      return false;
    }

    // Building a `c` sequence.
    if (e.key === "Escape") {
      this.clearPrefix();
      return true;
    }
    if (k === "l" && this.prefix.length === 1) {
      this.prefix.push("l");
      this.showPrefixHud();
      return true;
    }
    if (k === "x" || k === "y" || k === "z") {
      const frame = this.prefix.includes("l") ? "layer" : "world";
      this.start(new CameraMoveOperator(this.ctx, k as AxisName, frame));
      return true;
    }
    // Unknown key: stay in the sequence (spec), but swallow the key.
    return true;
  }

  handlePointerDown(e: PointerEvent): boolean {
    if (this.op) {
      if (e.button === 0) this.finish(true);
      else if (e.button === 2) this.finish(false);
      return true;
    }
    if (this.prefix.length > 0) this.clearPrefix();
    return false;
  }

  handlePointerMove(e: PointerEvent): boolean {
    if (!this.op) return false;
    this.op.onPointerMove(e.movementX, e.movementY);
    this.refreshHud();
    return true;
  }

  // --- internals ---

  private startTransform(mode: "translate" | "rotate"): void {
    const op = new TransformOperator(this.ctx, mode);
    if (!op.hasTargets) {
      this.ctx.ui.setStatus(`Nothing selected to ${mode} — select something first`);
      return;
    }
    this.start(op);
  }

  private start(op: Operator): void {
    this.prefix = [];
    this.op = op;
    this.ctx.view.rig.suspended = true;
    this.refreshHud();
  }

  private finish(commit: boolean): void {
    if (!this.op) return;
    if (commit) this.op.confirm();
    else this.op.cancel();
    this.op = null;
    this.ctx.view.rig.suspended = false;
    this.ctx.ui.setHud(null);
  }

  private clearPrefix(): void {
    this.prefix = [];
    this.ctx.ui.setHud(null);
  }

  private showPrefixHud(): void {
    const words = this.prefix.includes("l") ? "Camera · layer axis · …" : "Camera · …";
    this.ctx.ui.setHud([[this.prefix.map((c) => c.toUpperCase()).join(" · "), words]]);
  }

  private refreshHud(): void {
    if (this.op) this.ctx.ui.setHud(this.op.hud());
  }
}
