import type { EditorContext } from "@plugins/api";
import type { CameraPose, StoredMap } from "@io/mapStore";
import { saveMap, setCurrentId, toLayers } from "@io/mapStore";

/**
 * Editing-session state: which map is live and whether autosave may run.
 * `ready` stays false until a real map is opened/created, so the empty
 * boot document never lands in the database.
 */
export const session = { ready: false };

/** Persist the current document and mark it current for the next visit. */
export async function persistNow(ctx: EditorContext): Promise<void> {
  if (!session.ready) return;
  try {
    // Camera rides along so the map opens where you left it on OTHER
    // machines too (freshness caveat: only updates when an edit autosaves).
    await saveMap(ctx.document, ctx.view.rig.getState());
    setCurrentId(ctx.document.id);
  } catch (err) {
    ctx.ui.setStatus(`Save failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Open a stored map into the editor. */
export function applyStored(ctx: EditorContext, rec: StoredMap): void {
  ctx.document.id = rec.id;
  ctx.document.globalClampToBase = rec.globalClampToBase ?? false;
  ctx.document.reset(toLayers(rec), {
    name: rec.name,
    decoration: rec.decorationBase + rec.mood,
    size: rec.size,
    modUrl: rec.modUrl,
    activeMod: rec.activeMod,
    colorPalette: rec.colorPalette,
  });
  session.ready = true;
  setCurrentId(rec.id);
  restoreCamera(ctx, rec.camera);
  ctx.ui.setStatus(`Opened ${rec.name} (${rec.placementCount} placements)`);
}

// --- camera persistence (per map, survives reloads) ---

const camKey = (mapId: string) => `trackedit.cam.${mapId}`;

/**
 * Restore priority: this browser's localStorage pose (freshest — saved every
 * second, while the stored-map pose only updates when an edit autosaves),
 * else the pose saved in the map record (new browser/machine), else default.
 */
export function restoreCamera(ctx: EditorContext, stored?: CameraPose): void {
  try {
    const raw = localStorage.getItem(camKey(ctx.document.id));
    if (raw) {
      ctx.view.rig.setState(JSON.parse(raw));
      return;
    }
  } catch {
    /* storage unavailable or corrupt — fall through */
  }
  if (stored) ctx.view.rig.setState(stored);
}

/** Call periodically; writes only when the pose actually changed. */
export function saveCamera(ctx: EditorContext): void {
  if (!session.ready) return;
  try {
    const state = JSON.stringify(ctx.view.rig.getState());
    const key = camKey(ctx.document.id);
    if (localStorage.getItem(key) !== state) localStorage.setItem(key, state);
  } catch {
    /* storage unavailable */
  }
}
