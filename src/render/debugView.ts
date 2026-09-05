import { Box3, Mesh, Vector3 } from "three";
import type { EditorContext } from "@plugins/api";

export interface DebugViewOptions {
  uid?: string;
  /** Camera angles in degrees; negative pitch looks down. */
  yaw?: number;
  pitch?: number;
  distance?: number;
  isolate?: boolean;
  client?: string;
}

export function debugSubject(ctx: EditorContext, options: DebugViewOptions) {
  const ids = options.uid ? [options.uid] : ctx.selection.list.map(e => e.placementId);
  const objects = ids.map(id => {
    const obj = ctx.renderer.getObject(id);
    if (!obj) throw new Error(`No rendered placement ${id}`);
    return obj;
  });
  const bounds = new Box3();
  for (const obj of objects) bounds.expandByObject(obj);
  if (bounds.isEmpty()) throw new Error("Select a rendered block first");
  return { ids, objects, bounds };
}

export function frameDebugSubject(ctx: EditorContext, options: DebugViewOptions) {
  const subject = debugSubject(ctx, options);
  for (const value of [options.yaw, options.pitch, options.distance]) {
    if (value !== undefined && !Number.isFinite(value)) throw new Error("Invalid camera value");
  }
  if (options.distance !== undefined && options.distance <= 0) throw new Error("Distance must be positive");
  const cam = ctx.view.camera;
  const halfFov = Math.atan(Math.tan(cam.fov * Math.PI / 360) * Math.min(1, cam.aspect));
  const radius = Math.max(subject.bounds.getSize(new Vector3()).length() / 2, 1);
  const distance = options.distance ?? radius / Math.sin(halfFov) * 1.15;
  ctx.view.rig.lookAt(subject.bounds.getCenter(new Vector3()), distance,
    (options.yaw ?? 45) * Math.PI / 180, (options.pitch ?? -30) * Math.PI / 180);
  ctx.view.rig.update(0);
  return subject;
}

/** A temporary framing/isolation never changes the user's saved camera or visibility. */
export function captureDebugSubject(ctx: EditorContext, target: string, options: DebugViewOptions) {
  const { rig, camera } = ctx.view;
  const saved = { rig: rig.getState(),
    cameraPos: camera.position.clone(), quaternion: camera.quaternion.clone() };
  const hidden: Array<{ visible: boolean }> = [];
  try {
    const subject = target === "view" ? undefined : frameDebugSubject(ctx, options);
    if (options.isolate) {
      const keep = new Set((subject ?? debugSubject(ctx, options)).ids);
      for (const layer of ctx.document.layers) for (const id of layer.placements.keys()) {
        const obj = ctx.renderer.getObject(id);
        if (obj?.visible && !keep.has(id)) { hidden.push(obj); obj.visible = false; }
      }
    }
    return ctx.view.captureFrame();
  } finally {
    for (const obj of hidden) obj.visible = true;
    rig.setState(saved.rig);
    camera.position.copy(saved.cameraPos); camera.quaternion.copy(saved.quaternion);
    ctx.view.captureFrame();
  }
}

export function inspectDebugSubject(ctx: EditorContext, options: DebugViewOptions) {
  const { ids, objects, bounds } = debugSubject(ctx, options);
  const meshes: Record<string, unknown>[] = [];
  for (const obj of objects) obj.traverse(node => {
    if (!(node instanceof Mesh)) return;
    meshes.push({ name: node.name, vertices: node.geometry.getAttribute("position")?.count,
      uvCount: node.geometry.getAttribute("uv")?.count,
      materials: (Array.isArray(node.material) ? node.material : [node.material]).map(mat => {
        const map = "map" in mat ? mat.map as import("three").Texture | null : null;
        return { name: mat.userData.matName ?? mat.name, side: mat.side,
          texture: map?.image?.src ?? null, flipY: map?.flipY ?? null };
      }) });
  });
  return { ids, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, meshes };
}
