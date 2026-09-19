import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { InstanceBatcher } from "./InstanceBatcher";

const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial();
const other = new MeshBasicMaterial();

/** A placement-like object: a root with a body mesh and a clip-cap mesh. */
function placement(x: number, z: number, mat = material): Group {
  const root = new Group();
  root.position.set(x, 8, z);
  const body = new Mesh(geometry, mat);
  const cap = new Mesh(geometry, mat);
  cap.name = "clip:cap";
  cap.position.set(16, 0, 0);
  root.add(body, cap);
  return root;
}

const batchesOf = (host: Group) => host.children.filter((c): c is InstancedMesh => c instanceof InstancedMesh);
const total = (host: Group) => batchesOf(host).reduce((n, b) => n + b.count, 0);

describe("InstanceBatcher", () => {
  it("draws many objects of one mesh with one batch per chunk", () => {
    const host = new Group();
    const batcher = new InstanceBatcher(384);
    for (let i = 0; i < 50; i++) batcher.set(`p${i}`, placement(i * 4, 10), host);
    batcher.set("far", placement(5000, 10), host);
    batcher.flush();
    expect(batchesOf(host)).toHaveLength(2);
    expect(total(host)).toBe(51 * 2);
    expect(batcher.stats).toEqual({ batches: 2, instances: 102, objects: 51 });
  });

  it("places instances where the meshes are, relative to the host", () => {
    const host = new Group();
    const batcher = new InstanceBatcher();
    batcher.set("a", placement(100, 200), host);
    batcher.flush();
    const seen: Vector3[] = [];
    const m = new Matrix4();
    for (const b of batchesOf(host)) for (let i = 0; i < b.count; i++) {
      b.getMatrixAt(i, m);
      seen.push(new Vector3().setFromMatrixPosition(m));
    }
    expect(seen.map((v) => v.toArray()).sort()).toEqual([[100, 8, 200], [116, 8, 200]]);
  });

  it("skips hidden parts and hidden objects, and follows re-registration", () => {
    const host = new Group();
    const batcher = new InstanceBatcher();
    const obj = placement(0, 0);
    batcher.set("a", obj, host);
    batcher.flush();
    expect(total(host)).toBe(2);

    obj.children[1].visible = false; // the clip cap joins a neighbour
    batcher.set("a", obj, host);
    batcher.flush();
    expect(total(host)).toBe(1);

    obj.visible = false;
    batcher.set("a", obj, host);
    batcher.flush();
    expect(total(host)).toBe(0);
    expect(batchesOf(host)).toHaveLength(0);
    expect(batcher.has("a")).toBe(false);
  });

  it("keeps different materials apart and removes what is unregistered", () => {
    const host = new Group();
    const batcher = new InstanceBatcher();
    batcher.set("a", placement(0, 0), host);
    batcher.set("b", placement(4, 0, other), host);
    batcher.flush();
    expect(batchesOf(host)).toHaveLength(2);
    batcher.set("b", null);
    batcher.flush();
    expect(batchesOf(host)).toHaveLength(1);
    expect(batchesOf(host)[0].material).toBe(material);
  });

  it("grows a batch without losing earlier instances, and clears per host", () => {
    const host = new Group(), second = new Group();
    const batcher = new InstanceBatcher();
    for (let i = 0; i < 3; i++) batcher.set(`p${i}`, placement(i, 0), host);
    batcher.flush();
    for (let i = 3; i < 40; i++) batcher.set(`p${i}`, placement(i, 0), host);
    batcher.set("s", placement(0, 0), second);
    batcher.flush();
    expect(total(host)).toBe(80);
    batcher.clearHost(host);
    expect(batchesOf(host)).toHaveLength(0);
    expect(total(second)).toBe(2);
    expect(batcher.stats.objects).toBe(1);
  });
});
