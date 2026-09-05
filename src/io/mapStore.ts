import type { Layer, Placement } from "@core/layer";
import { DEFAULT_LOD_DISTANCE, createLayer } from "@core/layer";
import type { MapDocument } from "@core/document";
import type { GridCoord, Vec3 } from "@core/math";
import type { Mood } from "@core/mapbase";

/**
 * Map persistence, backed by the dev server's file store (maps/*.json via
 * /api/maps) so saved tracks open from ANY browser or profile on this
 * machine — browser storage (localStorage ~5MB, IndexedDB per-profile) is
 * unsuitable. A future multi-user database can sit behind the same
 * endpoints without touching callers.
 *
 * Only editable STATE is stored — layers, placements, map meta. Geometry is
 * never stored: official meshes come from the app's library and embedded
 * custom meshes live on disk (re-extractable from the map / TMX).
 *
 * The "current track" pointer stays in localStorage: it's a per-browser
 * convenience (which track to reopen on refresh), not map data.
 */

const CURRENT_KEY = "trackedit.currentMap";

export interface StoredLayer {
  name: string;
  visible: boolean;
  locked: boolean;
  clampToBase?: boolean;
  settings: { gridStep: Vec3; lodDistance?: number };
  transform: { translate: Vec3; rotDeg: Vec3 };
  placements: Placement[];
}

export interface StoredMapMeta {
  id: string;
  name: string;
  updatedAt: number;
  placementCount: number;
  decorationBase: string;
  mood: Mood;
  size: GridCoord;
}

export interface StoredMap extends StoredMapMeta {
  globalClampToBase?: boolean;
  /** The map's own custom texture pack URL (from import), if any. */
  modUrl?: string | null;
  /** Slug of the applied mod from the downloaded-mods library. */
  activeMod?: string | null;
  /** Palette painted blocks resolve through (core/palettes.ts). */
  colorPalette?: string;
  layers: StoredLayer[];
}

export function serializeDoc(doc: MapDocument): StoredMap {
  let count = 0;
  const layers: StoredLayer[] = doc.layers.map((l) => {
    count += l.placements.size;
    return {
      name: l.name,
      visible: l.visible,
      locked: l.locked,
      clampToBase: l.clampToBase,
      settings: { gridStep: [...l.settings.gridStep] as Vec3, lodDistance: l.settings.lodDistance },
      transform: {
        translate: [...l.transform.translate] as Vec3,
        rotDeg: [...l.transform.rotDeg] as Vec3,
      },
      placements: [...l.placements.values()],
    };
  });
  return {
    id: doc.id,
    name: doc.name,
    updatedAt: Date.now(),
    placementCount: count,
    globalClampToBase: doc.globalClampToBase,
    modUrl: doc.modUrl,
    activeMod: doc.activeMod,
    colorPalette: doc.colorPalette,
    decorationBase: doc.decorationBase,
    mood: doc.mood,
    size: [...doc.size] as GridCoord,
    layers,
  };
}

export function toLayers(rec: StoredMap): Layer[] {
  return rec.layers.map((sl) => {
    const layer = createLayer(sl.name);
    layer.visible = sl.visible;
    layer.locked = sl.locked;
    layer.clampToBase = sl.clampToBase ?? false;
    layer.settings = {
      gridStep: [...sl.settings.gridStep] as Vec3,
      lodDistance: sl.settings.lodDistance ?? DEFAULT_LOD_DISTANCE,
    };
    layer.transform = {
      translate: [...sl.transform.translate] as Vec3,
      rotDeg: [...sl.transform.rotDeg] as Vec3,
    };
    for (const p of sl.placements) layer.placements.set(p.id, p);
    return layer;
  });
}

export async function saveMap(doc: MapDocument): Promise<void> {
  const rec = serializeDoc(doc);
  const res = await fetch(`/api/maps/${encodeURIComponent(rec.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rec),
  });
  if (!res.ok) throw new Error(`save failed (${res.status})`);
}

export async function loadMap(id: string): Promise<StoredMap | null> {
  const res = await fetch(`/api/maps/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return (await res.json()) as StoredMap;
}

export async function listMaps(): Promise<StoredMapMeta[]> {
  const res = await fetch("/api/maps");
  if (!res.ok) return [];
  const all = (await res.json()) as StoredMapMeta[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteMap(id: string): Promise<void> {
  await fetch(`/api/maps/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getCurrentId(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

export function setCurrentId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(CURRENT_KEY);
    else localStorage.setItem(CURRENT_KEY, id);
  } catch { /* storage unavailable */ }
}
