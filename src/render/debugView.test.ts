import { describe, expect, it } from "vitest";
import { BoxGeometry, Mesh, PerspectiveCamera, Scene, Vector3 } from "three";
import type { EditorContext } from "@plugins/api";
import { captureDebugSubject, frameDebugSubject } from "./debugView";

function fixture(aspect = 1) {
  const camera = new PerspectiveCamera(60, aspect, 0.1, 1000);
  const subject = new Mesh(new BoxGeometry(32, 10, 32));
  subject.position.set(720, 85, 816);
  const other = new Mesh();
  const scene = new Scene();
  scene.add(subject, other);
  const objects = new Map([["block", subject], ["other", other]]);
  let pose = { pos: [1, 2, 3] as [number, number, number], yaw: 0, pitch: 0, distance: 10 };
  const rig = {
    getState: () => ({ ...pose }),
    setState: (s: typeof pose) => { pose = s; },
    lookAt: (focus: Vector3, distance: number, yaw: number, pitch: number) => {
      const offset = new Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      camera.position.copy(focus).addScaledVector(offset, distance);
      camera.lookAt(focus);
      camera.updateMatrixWorld();
      pose = { pos: camera.position.toArray(), yaw, pitch, distance };
    },
    update: () => {},
  };
  const view = { camera, rig, captureFrame: () => "data:image/png;base64,test" };
  const ctx = { view, renderer: { getObject: (id: string) => objects.get(id) },
    selection: { list: [{ placementId: "block" }] },
    document: { layers: [{ placements: objects }] } } as unknown as EditorContext;
  return { ctx, view, other };
}

describe("block debug views", () => {
  it.each([0.4, 2.4])("fits all block corners in aspect %s", aspect => {
    const { ctx } = fixture(aspect);
    const { bounds } = frameDebugSubject(ctx, {});
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          const ndc = new Vector3(x, y, z).project(ctx.view.camera);
          expect(Math.abs(ndc.x)).toBeLessThan(1);
          expect(Math.abs(ndc.y)).toBeLessThan(1);
        }
  });

  it("restores camera and hidden placements even when capture fails", () => {
    const { ctx, view, other } = fixture();
    const pose = view.rig.getState();
    const cameraPos = view.camera.position.clone();
    view.captureFrame = () => {
      if (!other.visible) throw new Error("capture failed");
      return "restored";
    };
    expect(() => captureDebugSubject(ctx, "selection", { isolate: true })).toThrow("capture failed");
    expect(other.visible).toBe(true);
    expect(view.rig.getState()).toEqual(pose);
    expect(view.camera.position).toEqual(cameraPos);
  });

  it("rejects a missing block instead of returning an unrelated screenshot", () => {
    const { ctx } = fixture();
    expect(() => captureDebugSubject(ctx, "selection", { uid: "missing" })).toThrow("No rendered placement");
  });
});
