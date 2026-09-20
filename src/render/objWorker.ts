/// <reference lib="webworker" />
/**
 * Mesh loading off the main thread. A big map needs about a thousand block
 * meshes — hundreds of megabytes of OBJ text whose parsing alone is ~11 s of
 * CPU. Done on the page's thread it is both the wait after a reload and the
 * stutter while flying; done here it runs on every core at once and the page
 * only receives finished buffers (transferred, not copied).
 *
 * In: { id, url }. Out: { id, meshes } or { id, error }.
 */
import type { BufferGeometry, Material, Mesh } from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

export interface WorkerMesh {
  name: string;
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array | null;
  /** Material names, one per geometry group (OBJ `usemtl`). */
  materials: string[];
  groups: Array<{ start: number; count: number; materialIndex: number }>;
}

export interface WorkerReply {
  id: number;
  meshes?: WorkerMesh[];
  error?: string;
}

const loader = new OBJLoader();
const scope = self as unknown as { postMessage(message: WorkerReply, transfer?: Transferable[]): void };

self.onmessage = async (ev: MessageEvent<{ id: number; url: string }>) => {
  const { id, url } = ev.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const root = loader.parse(await res.text());
    const meshes: WorkerMesh[] = [];
    const transfer: Transferable[] = [];
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;
      const geometry = mesh.geometry as BufferGeometry;
      // The same shading the main thread used to compute after every load.
      geometry.computeVertexNormals();
      const position = geometry.getAttribute("position").array as Float32Array;
      const normal = geometry.getAttribute("normal").array as Float32Array;
      const uv = (geometry.getAttribute("uv")?.array as Float32Array | undefined) ?? null;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
      meshes.push({
        name: mesh.name,
        position, normal, uv,
        materials: mats.map((m) => m.name || "default"),
        groups: geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex ?? 0 })),
      });
      transfer.push(position.buffer, normal.buffer);
      if (uv) transfer.push(uv.buffer);
    });
    scope.postMessage({ id, meshes }, transfer);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
