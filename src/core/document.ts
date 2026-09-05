import { Emitter } from "./events";
import type { Layer, Placement } from "./layer";
import { clampTransformToBase, createLayer } from "./layer";
import type { GridCoord } from "./math";
import { CELL, MAP_SIZE, coordEquals, newId } from "./math";
import type { BaseType, MapBase, Mood } from "./mapbase";
import { baseTypeOf, parseDecoration } from "./mapbase";

export interface DocumentEvents extends Record<string, unknown> {
  placementAdded: { layer: Layer; placement: Placement };
  placementRemoved: { layer: Layer; placement: Placement };
  layerAdded: { layer: Layer };
  layerRemoved: { layer: Layer };
  /** Any layer property change: name, visibility, settings, transform. */
  layerChanged: { layer: Layer };
  activeLayerChanged: { layer: Layer };
  /** Whole document replaced (new/import). Rebuild everything. */
  reset: Record<string, never>;
  /** Map base or mood changed (size, decoration, lighting). */
  mapChanged: Record<string, never>;
}

/**
 * The map being edited. Holds only state and low-level mutations; all editing
 * goes through commands (see commands.ts) so it stays undoable. Mutation
 * methods are prefixed `mut` and must only be called by Command objects.
 */
export class MapDocument {
  readonly events = new Emitter<DocumentEvents>();
  /** Persistence identity (io/mapStore) — reassigned by new/clone/load flows. */
  id = newId("map");
  name = "Untitled";
  /** Decoration id without the mood suffix (see core/mapbase.ts). */
  decorationBase = "48x48Screen155";
  mood: Mood = "Day";
  size: GridCoord = MAP_SIZE;
  /** The map's own custom texture pack (mod) URL, from import — if any. */
  modUrl: string | null = null;
  /** Slug of the mod currently APPLIED (any downloaded mod, not just the map's). */
  activeMod: string | null = null;

  setActiveMod(slug: string | null): void {
    this.activeMod = slug;
    this.events.emit("mapChanged", {});
  }

  /** Which color palette painted blocks resolve through (core/palettes.ts). */
  colorPalette = "Classic";

  setColorPalette(name: string): void {
    this.colorPalette = name;
    this.events.emit("mapChanged", {});
  }

  /** Full game decoration id, e.g. "NoStadium48x48Sunset". */
  get decoration(): string {
    return this.decorationBase + this.mood;
  }

  get baseType(): BaseType {
    return baseTypeOf(this.decorationBase);
  }

  setMapBase(base: MapBase): void {
    this.decorationBase = base.decoration;
    this.size = base.size;
    this.events.emit("mapChanged", {});
  }

  setMood(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.events.emit("mapChanged", {});
  }

  /** Global override: no layer may rotate or translate below the base grid. */
  globalClampToBase = false;

  setGlobalClampToBase(on: boolean): void {
    if (on === this.globalClampToBase) return;
    this.globalClampToBase = on;
    if (on) {
      for (const layer of this.layerList) {
        const clamped = this.clampFor(layer, layer.transform);
        if (clamped !== layer.transform) {
          layer.transform = clamped;
          this.events.emit("layerChanged", { layer });
        }
      }
    }
    this.events.emit("mapChanged", {});
  }

  private clampFor(layer: Layer, t: Layer["transform"]): Layer["transform"] {
    if (!this.globalClampToBase && !layer.clampToBase) return t;
    return clampTransformToBase(t, this.size[0] * CELL[0], this.size[2] * CELL[2]);
  }

  private layerList: Layer[] = [];
  private activeId: string;

  constructor() {
    const base = createLayer("Base");
    this.layerList.push(base);
    this.activeId = base.id;
  }

  get layers(): readonly Layer[] {
    return this.layerList;
  }

  getLayer(id: string): Layer | undefined {
    return this.layerList.find((l) => l.id === id);
  }

  get activeLayer(): Layer {
    return this.getLayer(this.activeId) ?? this.layerList[0];
  }

  setActiveLayer(id: string): void {
    const layer = this.getLayer(id);
    if (!layer || this.activeId === id) return;
    this.activeId = id;
    this.events.emit("activeLayerChanged", { layer });
  }

  findBlockAt(layer: Layer, coord: GridCoord): Placement | undefined {
    for (const p of layer.placements.values())
      if (p.kind === "block" && coordEquals(p.coord, coord)) return p;
    return undefined;
  }

  // --- low-level mutations (commands only) ---

  mutAddPlacement(layerId: string, placement: Placement): void {
    const layer = this.getLayer(layerId);
    if (!layer) return;
    layer.placements.set(placement.id, placement);
    this.events.emit("placementAdded", { layer, placement });
  }

  mutRemovePlacement(layerId: string, placementId: string): Placement | undefined {
    const layer = this.getLayer(layerId);
    const placement = layer?.placements.get(placementId);
    if (!layer || !placement) return undefined;
    layer.placements.delete(placementId);
    this.events.emit("placementRemoved", { layer, placement });
    return placement;
  }

  mutAddLayer(layer: Layer, index?: number): void {
    if (index === undefined || index < 0 || index > this.layerList.length)
      this.layerList.push(layer);
    else this.layerList.splice(index, 0, layer);
    this.events.emit("layerAdded", { layer });
  }

  mutRemoveLayer(layerId: string): { layer: Layer; index: number } | undefined {
    const index = this.layerList.findIndex((l) => l.id === layerId);
    if (index < 0 || this.layerList.length === 1) return undefined;
    const [layer] = this.layerList.splice(index, 1);
    if (this.activeId === layerId) this.setActiveLayer(this.layerList[0].id);
    this.events.emit("layerRemoved", { layer });
    return { layer, index };
  }

  /** Apply a partial update to a layer and notify. Returns the previous values of the touched keys. */
  mutUpdateLayer(layerId: string, patch: Partial<Omit<Layer, "id" | "placements">>): Partial<Layer> | undefined {
    const layer = this.getLayer(layerId);
    if (!layer) return undefined;
    const prev: Record<string, unknown> = {};
    const oldTransform = layer.transform;
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      prev[key] = layer[key];
      (layer as unknown as Record<string, unknown>)[key] = patch[key];
    }
    // Sub-base clamp (per-layer setting or the global override).
    const clamped = this.clampFor(layer, layer.transform);
    if (clamped !== layer.transform) {
      if (!("transform" in prev)) prev.transform = oldTransform;
      layer.transform = clamped;
    }
    this.events.emit("layerChanged", { layer });
    return prev as Partial<Layer>;
  }

  /** Replace all content (import / new document). Not undoable. */
  reset(
    layers: Layer[],
    meta?: {
      name?: string;
      decoration?: string;
      size?: GridCoord;
      modUrl?: string | null;
      activeMod?: string | null;
      colorPalette?: string;
    },
  ): void {
    this.layerList = layers.length ? layers : [createLayer("Base")];
    this.activeId = this.layerList[0].id;
    if (meta?.name) this.name = meta.name;
    if (meta?.decoration) {
      const parsed = parseDecoration(meta.decoration);
      this.decorationBase = parsed.base;
      this.mood = parsed.mood;
    }
    if (meta?.size) this.size = meta.size;
    // Mods are per-map: opening a map replaces them (undefined = clear).
    this.modUrl = meta?.modUrl ?? null;
    this.activeMod = meta?.activeMod ?? null;
    this.colorPalette = meta?.colorPalette ?? "Classic";
    this.events.emit("reset", {});
    this.events.emit("mapChanged", {});
  }
}
