import type { MapDocument } from "@core/document";
import type { History } from "@core/commands";
import type { BlockCatalog } from "@core/catalog";
import type { SelectionModel } from "@core/selection";
import type { Emitter } from "@core/events";
import type { SceneView } from "@render/SceneView";
import type { DocumentRenderer } from "@render/DocumentRenderer";
import type { GeometryProvider } from "@render/GeometryProvider";
import type { ToolManager } from "@tools/ToolManager";

/** App-wide events that are not owned by a specific subsystem. */
export interface AppEvents extends Record<string, unknown> {
  /** A block was chosen in the palette (arms the place tool). */
  blockArmed: { name: string };
  /** Place tool switched between grid and free placement. */
  placeModeChanged: { mode: "grid" | "free" };
  /** A real mesh finished loading for this block (visuals were rebuilt). */
  geometryLoaded: { name: string };
  /** The paint tool's active color changed. */
  paintColorChanged: { color: string };
  status: { text: string };
}

export interface PanelDef {
  id: string;
  title: string;
  side: "left" | "right";
  element: HTMLElement;
  /** Lower comes first. Built-ins use 10/20/30. */
  order?: number;
}

export interface UiHost {
  registerPanel(panel: PanelDef): void;
  setStatus(text: string): void;
  /** Middle status-bar slot for persistent readouts (selection uid etc.). */
  readonly statusInfo?: HTMLElement;
  /**
   * Viewport overlay for modal input (sequence letters, live values).
   * Each entry is one line: [emphasised, plain] text. null hides the HUD.
   */
  setHud(lines: Array<[string, string]> | null): void;
}

/**
 * Everything a plugin can touch. Built-in features (tools, panels) are
 * implemented against this exact surface, so anything we can do internally a
 * third-party plugin can too.
 */
export interface EditorContext {
  readonly document: MapDocument;
  readonly history: History;
  readonly catalog: BlockCatalog;
  readonly selection: SelectionModel;
  readonly view: SceneView;
  readonly renderer: DocumentRenderer;
  readonly geometry: GeometryProvider;
  readonly tools: ToolManager;
  readonly ui: UiHost;
  readonly events: Emitter<AppEvents>;
}

export interface EditorPlugin {
  readonly id: string;
  readonly name: string;
  init(ctx: EditorContext): void;
}

export class PluginHost {
  private plugins: EditorPlugin[] = [];

  constructor(private ctx: EditorContext) {}

  use(plugin: EditorPlugin): void {
    this.plugins.push(plugin);
    plugin.init(this.ctx);
  }

  get installed(): readonly EditorPlugin[] {
    return this.plugins;
  }
}
