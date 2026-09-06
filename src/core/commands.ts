import { Emitter } from "./events";
import type { MapDocument } from "./document";
import type { Layer, Placement } from "./layer";

/**
 * Every edit is a Command so undo/redo works uniformly — including edits made
 * by future plugins, which get the same History through the plugin API.
 */
export interface Command {
  readonly label: string;
  execute(doc: MapDocument): void;
  undo(doc: MapDocument): void;
}

export interface HistoryEvents extends Record<string, unknown> {
  changed: { undoLabel?: string; redoLabel?: string };
}

export class History {
  readonly events = new Emitter<HistoryEvents>();
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  constructor(private doc: MapDocument) {}

  run(cmd: Command): void {
    cmd.execute(this.doc);
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.notify();
  }

  /**
   * Record an ALREADY-EXECUTED command as one undo step — for interactions
   * that apply incrementally (paint strokes) but undo as a whole.
   */
  commit(cmd: Command): void {
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.notify();
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo(this.doc);
    this.redoStack.push(cmd);
    this.notify();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.execute(this.doc);
    this.undoStack.push(cmd);
    this.notify();
  }

  /** A remote edit or document replacement invalidates stored local command targets. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify();
  }

  private notify(): void {
    this.events.emit("changed", {
      undoLabel: this.undoStack.at(-1)?.label,
      redoLabel: this.redoStack.at(-1)?.label,
    });
  }
}

// --- concrete commands ---

/** Several commands as one undo step (e.g. transforming a multi-selection). */
export class CompositeCmd implements Command {
  constructor(private cmds: Command[], readonly label: string) {}

  execute(doc: MapDocument): void {
    for (const cmd of this.cmds) cmd.execute(doc);
  }

  undo(doc: MapDocument): void {
    for (let i = this.cmds.length - 1; i >= 0; i--) this.cmds[i].undo(doc);
  }
}

export class AddPlacementCmd implements Command {
  readonly label: string;
  /** Placements displaced by this one (e.g. the block previously in the cell). */
  private displaced: Placement[] = [];

  constructor(
    private layerId: string,
    private placement: Placement,
    displaced: Placement[] = [],
  ) {
    this.displaced = displaced;
    this.label = `Place ${placement.block}`;
  }

  execute(doc: MapDocument): void {
    for (const d of this.displaced) doc.mutRemovePlacement(this.layerId, d.id);
    doc.mutAddPlacement(this.layerId, this.placement);
  }

  undo(doc: MapDocument): void {
    doc.mutRemovePlacement(this.layerId, this.placement.id);
    for (const d of this.displaced) doc.mutAddPlacement(this.layerId, d);
  }
}

export class RemovePlacementCmd implements Command {
  readonly label: string;
  private removed?: Placement;

  constructor(private layerId: string, private placementId: string, label = "Remove") {
    this.label = label;
  }

  execute(doc: MapDocument): void {
    this.removed = doc.mutRemovePlacement(this.layerId, this.placementId);
  }

  undo(doc: MapDocument): void {
    if (this.removed) doc.mutAddPlacement(this.layerId, this.removed);
  }
}

/** Replace a placement with an edited copy (rotate, move). Same id, new data. */
export class ReplacePlacementCmd implements Command {
  private previous?: Placement;

  constructor(
    private layerId: string,
    private next: Placement,
    readonly label = "Edit placement",
  ) {}

  execute(doc: MapDocument): void {
    this.previous = doc.mutRemovePlacement(this.layerId, this.next.id);
    doc.mutAddPlacement(this.layerId, this.next);
  }

  undo(doc: MapDocument): void {
    doc.mutRemovePlacement(this.layerId, this.next.id);
    if (this.previous) doc.mutAddPlacement(this.layerId, this.previous);
  }
}

export class AddLayerCmd implements Command {
  readonly label: string;

  constructor(private layer: Layer) {
    this.label = `Add layer ${layer.name}`;
  }

  execute(doc: MapDocument): void {
    doc.mutAddLayer(this.layer);
    doc.setActiveLayer(this.layer.id);
  }

  undo(doc: MapDocument): void {
    doc.mutRemoveLayer(this.layer.id);
  }
}

export class RemoveLayerCmd implements Command {
  readonly label = "Remove layer";
  private removed?: { layer: Layer; index: number };

  constructor(private layerId: string) {}

  execute(doc: MapDocument): void {
    this.removed = doc.mutRemoveLayer(this.layerId);
  }

  undo(doc: MapDocument): void {
    if (this.removed) doc.mutAddLayer(this.removed.layer, this.removed.index);
  }
}

export class UpdateLayerCmd implements Command {
  private previous?: Partial<Layer>;

  constructor(
    private layerId: string,
    private patch: Partial<Omit<Layer, "id" | "placements">>,
    readonly label = "Edit layer",
  ) {}

  execute(doc: MapDocument): void {
    this.previous = doc.mutUpdateLayer(this.layerId, this.patch);
  }

  undo(doc: MapDocument): void {
    if (this.previous) doc.mutUpdateLayer(this.layerId, this.previous);
  }
}
