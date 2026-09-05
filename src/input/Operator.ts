/**
 * A modal operator: armed by a key sequence, owns the mouse until confirmed
 * (left click / Enter) or cancelled (right click / Esc). Operators preview
 * their effect live and only write to the document on confirm — cancel must
 * restore the world exactly (spec ground rule "preview vs commit").
 */
export interface Operator {
  /** HUD lines: [emphasised, plain] per line. */
  hud(): Array<[string, string]>;
  onPointerMove(dx: number, dy: number): void;
  /** Refining keys (axis constraints, digits). True when consumed. */
  onKey(e: KeyboardEvent): boolean;
  confirm(): void;
  cancel(): void;
}
