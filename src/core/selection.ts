import { Emitter } from "./events";

/**
 * First-class selection state, shared between tools, modal operators and UI
 * (see docs/SPEC-sequence-shortcuts.md). Holds placement references today;
 * typed sub-element selections (face/edge/vertex) come later, which is why
 * entries are objects rather than bare ids.
 */
export interface SelectionEntry {
  readonly layerId: string;
  readonly placementId: string;
}

export interface SelectionEvents extends Record<string, unknown> {
  changed: { entries: readonly SelectionEntry[] };
}

export class SelectionModel {
  readonly events = new Emitter<SelectionEvents>();
  private entries: SelectionEntry[] = [];

  get list(): readonly SelectionEntry[] {
    return this.entries;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  set(entries: SelectionEntry[]): void {
    this.entries = entries;
    this.events.emit("changed", { entries });
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.set([]);
  }

  remove(placementId: string): void {
    if (!this.entries.some((e) => e.placementId === placementId)) return;
    this.set(this.entries.filter((e) => e.placementId !== placementId));
  }
}
