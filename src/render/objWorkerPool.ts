import { BufferAttribute, BufferGeometry, Group, Mesh } from "three";
import type { Material } from "three";
import type { WorkerMesh, WorkerReply } from "./objWorker";

/**
 * A pool of mesh-loading workers (see objWorker.ts): one per core, minus one
 * for the page. `load` resolves to the same object tree OBJLoader would have
 * built — a Group of named meshes, materials resolved by name — so callers
 * cannot tell the difference, except that nothing blocked the frame.
 */
export class ObjWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly waiting = new Map<number, { resolve: (m: WorkerMesh[]) => void; reject: (e: Error) => void }>();
  private next = 0;
  private ids = 0;

  /** Null where workers are unavailable (tests, very old browsers): the caller keeps its own loader. */
  static create(): ObjWorkerPool | null {
    if (typeof Worker === "undefined") return null;
    try {
      return new ObjWorkerPool();
    } catch {
      return null;
    }
  }

  private constructor() {
    // Measured on a 24-core machine: 12 workers load a big map in 4.7 s, 20 in 5.4 s —
    // past a dozen the dev server and the largest files set the pace, not the parsing.
    const count = Math.min(Math.max((navigator.hardwareConcurrency ?? 4) - 1, 2), 12);
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL("./objWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
        const job = this.waiting.get(ev.data.id);
        if (!job) return;
        this.waiting.delete(ev.data.id);
        if (ev.data.meshes) job.resolve(ev.data.meshes);
        else job.reject(new Error(ev.data.error ?? "mesh worker failed"));
      };
      this.workers.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  async load(url: string, materialFor: (name: string) => Material): Promise<Group> {
    const meshes = await new Promise<WorkerMesh[]>((resolve, reject) => {
      const id = ++this.ids;
      this.waiting.set(id, { resolve, reject });
      this.workers[this.next++ % this.workers.length].postMessage({ id, url: new URL(url, location.href).href });
    });
    return buildObject(meshes, materialFor);
  }
}

/** The object tree OBJLoader builds, from a worker's buffers. */
export function buildObject(meshes: readonly WorkerMesh[], materialFor: (name: string) => Material): Group {
  const root = new Group();
  for (const m of meshes) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(m.position, 3));
    geometry.setAttribute("normal", new BufferAttribute(m.normal, 3));
    if (m.uv) geometry.setAttribute("uv", new BufferAttribute(m.uv, 2));
    for (const g of m.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    const materials = m.materials.map(materialFor);
    // OBJLoader gives a single material when the mesh has one, an array otherwise.
    const mesh = new Mesh(geometry, materials.length === 1 ? materials[0] : materials);
    mesh.name = m.name;
    root.add(mesh);
  }
  return root;
}
