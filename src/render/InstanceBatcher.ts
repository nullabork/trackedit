import { Group, InstancedMesh, Matrix4 } from "three";
import type { BufferGeometry, Material, Mesh, Object3D } from "three";

/**
 * Draws many placements with few draw calls.
 *
 * A map is almost pure repetition: tens of thousands of placements of a
 * couple of thousand distinct meshes. Drawn one object each that is one draw
 * call per mesh per material — 50,000+ calls a frame on a big map, which is
 * what made the viewport crawl (the GPU was idle). Here every registered
 * object's meshes are grouped by (host, geometry, materials, map chunk) and
 * each group is ONE InstancedMesh. The chunk in the key keeps groups
 * spatially tight, so three.js frustum-culls whole groups by their bounding
 * sphere.
 *
 * The registered objects themselves are never rendered by the caller (they
 * stay around for picking and bounds); this class only reads them.
 */
export class InstanceBatcher {
  private readonly entries = new Map<string, Item[]>();
  private readonly batches = new Map<string, Batch>();
  private readonly dirty = new Set<Batch>();
  /** Shadows on the batches (small maps only: the shadow pass doubles the work). */
  shadows = false;

  /** `chunk`: edge of a culling cell in metres. */
  constructor(private readonly chunk = 768) {}

  /**
   * Register (or re-register) an object under an id: every visible mesh in it
   * becomes an instance. `host` is the group the batches are added to — the
   * object's transform is taken relative to it, so moving the host moves the
   * instances. Pass null to unregister.
   */
  set(id: string, obj: Object3D | null, host?: Group): void {
    const old = this.entries.get(id);
    if (old) {
      for (const item of old) {
        item.batch.members.delete(id);
        this.dirty.add(item.batch);
      }
      this.entries.delete(id);
    }
    if (!obj || !host || !obj.visible) return;

    const items: Item[] = [];
    const walk = (node: Object3D, parentMatrix: Matrix4) => {
      if (!node.visible || node.userData.isWire) return;
      node.updateMatrix();
      const matrix = new Matrix4().multiplyMatrices(parentMatrix, node.matrix);
      const mesh = node as Mesh;
      if ((mesh as { isMesh?: boolean }).isMesh && mesh.geometry && mesh.material) {
        const batch = this.batchFor(host, mesh.geometry, mesh.material, matrix);
        let list = batch.members.get(id);
        if (!list) batch.members.set(id, (list = []));
        list.push(matrix);
        items.push({ batch });
        this.dirty.add(batch);
      }
      for (const child of node.children) walk(child, matrix);
    };
    walk(obj, IDENTITY);
    if (items.length) this.entries.set(id, items);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  private batchFor(host: Group, geometry: BufferGeometry, material: Material | Material[], matrix: Matrix4): Batch {
    const e = matrix.elements;
    const mats = Array.isArray(material) ? material.map((m) => m.uuid).join(",") : material.uuid;
    const key = `${host.uuid}|${geometry.uuid}|${mats}|${Math.floor(e[12] / this.chunk)}:${Math.floor(e[14] / this.chunk)}`;
    let batch = this.batches.get(key);
    if (!batch) this.batches.set(key, (batch = { key, host, geometry, material, members: new Map(), mesh: null }));
    return batch;
  }

  /** Apply pending changes. Call once per frame, before rendering. */
  flush(): void {
    if (!this.dirty.size) return;
    for (const batch of this.dirty) this.rebuild(batch);
    this.dirty.clear();
  }

  private rebuild(batch: Batch): void {
    let count = 0;
    for (const list of batch.members.values()) count += list.length;
    if (count === 0) {
      batch.mesh?.removeFromParent();
      batch.mesh?.dispose();
      this.batches.delete(batch.key);
      return;
    }
    let mesh = batch.mesh;
    if (!mesh || mesh.instanceMatrix.count < count) {
      mesh?.removeFromParent();
      mesh?.dispose();
      // Headroom, so a growing neighbourhood does not reallocate every time.
      mesh = new InstancedMesh(batch.geometry, batch.material, Math.ceil(count * 1.25) + 2);
      mesh.name = "batch";
      mesh.raycast = () => {}; // picking goes through the registered objects
      batch.mesh = mesh;
      batch.host.add(mesh);
    }
    let i = 0;
    for (const list of batch.members.values()) for (const m of list) mesh.setMatrixAt(i++, m);
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = mesh.receiveShadow = this.shadows;
    mesh.computeBoundingSphere();
  }

  /** Drop everything (whole-document rebuild). */
  clear(): void {
    for (const batch of this.batches.values()) {
      batch.mesh?.removeFromParent();
      batch.mesh?.dispose();
    }
    this.batches.clear();
    this.entries.clear();
    this.dirty.clear();
  }

  /** Drop every batch that lives under a host (its layer went away). */
  clearHost(host: Group): void {
    for (const [id, items] of [...this.entries]) if (items.some((it) => it.batch.host === host)) this.entries.delete(id);
    for (const [key, batch] of [...this.batches]) {
      if (batch.host !== host) continue;
      batch.mesh?.removeFromParent();
      batch.mesh?.dispose();
      this.batches.delete(key);
      this.dirty.delete(batch);
    }
  }

  get stats(): { batches: number; instances: number; objects: number } {
    let instances = 0;
    for (const b of this.batches.values()) instances += b.mesh?.count ?? 0;
    return { batches: this.batches.size, instances, objects: this.entries.size };
  }
}

const IDENTITY = new Matrix4();

interface Batch {
  key: string;
  host: Group;
  geometry: BufferGeometry;
  material: Material | Material[];
  /** Registered id -> its instance matrices in this batch (host-local). */
  members: Map<string, Matrix4[]>;
  mesh: InstancedMesh | null;
}

interface Item {
  batch: Batch;
}
