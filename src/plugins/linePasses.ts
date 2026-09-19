import type { GhostPath, Layer } from "@core/layer";
import { Box3 } from "three";
import type { ModelBounds, WaypointPass, WaypointVolume } from "@core/waypoints";
import { linePasses, passesFromCheckpointTimes, toWorld, waypointVolumes } from "@core/waypoints";
import type { EditorContext } from "./api";

/**
 * The waypoints each driving line passes through (start, checkpoints in
 * driving order, finish), shared by the layers panel and the viewport's
 * checkpoint numbers. Computed on demand and kept until the map changes.
 */
let volumes: WaypointVolume[] | null = null;
let passes = new WeakMap<GhostPath, WaypointPass[]>();
let watching: EditorContext | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** Called (debounced) when the answers may have changed: blocks edited, a layer moved, item meshes loaded. */
export function onPassesChanged(ctx: EditorContext, cb: () => void): void {
  watch(ctx);
  listeners.add(cb);
}
const bounds = new Map<string, ModelBounds | undefined>();

/** An item's real size, from its mesh once that has loaded (custom checkpoint items come in every shape). */
function boundsOf(ctx: EditorContext, block: string): ModelBounds | undefined {
  if (bounds.has(block)) return bounds.get(block);
  const box = new Box3().setFromObject(ctx.geometry.getTemplate(ctx.catalog.get(block), block, true));
  const result = box.isEmpty() ? undefined : { min: box.min.toArray(), max: box.max.toArray() };
  bounds.set(block, result);
  return result;
}

function watch(ctx: EditorContext): void {
  if (watching === ctx) return;
  watching = ctx;
  const drop = () => {
    volumes = null;
    passes = new WeakMap();
    // Meshes stream in by the dozen: tell the views once things settle.
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => { for (const cb of listeners) cb(); }, 250);
  };
  // A mesh that arrives later replaces the placeholder it was measured from.
  ctx.events.on("geometryLoaded", ({ name }) => {
    if (bounds.delete(name)) drop();
  });
  for (const evt of ["placementAdded", "placementRemoved", "layerAdded", "layerRemoved", "reset"] as const) ctx.document.events.on(evt, drop);
  // Line edits also arrive as layerChanged: only a moved or hidden layer changes the answer.
  const sigOf = (layer: Layer) => JSON.stringify([layer.transform, layer.visible]);
  const seen = new Map(ctx.document.layers.map((l) => [l.id, sigOf(l)]));
  ctx.document.events.on("layerChanged", ({ layer }) => {
    if (seen.get(layer.id) !== sigOf(layer)) drop();
    seen.set(layer.id, sigOf(layer));
  });
}

export function passesOf(ctx: EditorContext, layer: Layer, ghost: GhostPath): WaypointPass[] {
  watch(ctx);
  const hit = passes.get(ghost);
  if (hit) return hit;
  volumes ??= waypointVolumes(ctx.document.layers, ctx.waypoints, (block) => ctx.catalog.get(block)?.size, (block) => boundsOf(ctx, block));
  // The ghost's own checkpoint times are exact; lines loaded before those were
  // kept fall back to geometry (every line is a completed run: a record, a
  // replay or the validation ghost).
  const world = toWorld(layer, ghost.path);
  const result = ghost.checkpoints?.length && ghost.times?.length === ghost.path.length
    ? passesFromCheckpointTimes(world, ghost.times, ghost.checkpoints, volumes)
    : linePasses(world, volumes, ghost.times, true);
  passes.set(ghost, result);
  return result;
}
