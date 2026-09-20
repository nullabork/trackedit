import { describe, expect, it } from "vitest";
import type { Vec3 } from "@core/math";
import type { BlockClipInfo } from "./clipAdjacency";
import { ClipFaceIndex, freeClipFaces, gridClipFaces, hiddenClipFaces } from "./clipFaces";

/** An expandable gate: posts on its east and west side that mate Left<->Right, a top bar and a foot. */
const gate = (): BlockClipInfo => ({
  size: [1, 1, 1],
  units: [[0, 0, 0]],
  clips: [
    { u: [0, 0, 0], face: "east", id: "GateRightVFC", group: "GateRightVFC", sym: "GateLeftVFC" },
    { u: [0, 0, 0], face: "west", id: "GateLeftVFC", group: "GateLeftVFC", sym: "GateRightVFC" },
    { u: [0, 0, 0], face: "top", id: "GateFCT", group: "GateFCT", sym: "GateFCB" },
    { u: [0, 0, 0], face: "bottom", id: "GateFCB", group: "GateFCB", sym: "GateFCT" },
  ],
});

const hiddenOf = (placed: Array<{ id: string; pos: Vec3; rot: Vec3 }>) => {
  const index = new ClipFaceIndex();
  const faces = placed.map((p) => freeClipFaces(p.id, p.pos, p.rot, gate()));
  for (const f of faces.flat()) index.add(f);
  return faces.map((f) => [...hiddenClipFaces(f, index)].sort());
};

describe("free block clips", () => {
  it("a free block on its own keeps every clip", () => {
    expect(hiddenOf([{ id: "a", pos: [100, 50, 100], rot: [0, 0, 0] }])).toEqual([[]]);
  });

  it("two free gates side by side lose the posts between them, not the outer ones", () => {
    // East is the x=0 face, west x=32: b stands on a's west side.
    const [a, b] = hiddenOf([
      { id: "a", pos: [100, 50, 100], rot: [0, 0, 0] },
      { id: "b", pos: [132, 50, 100], rot: [0, 0, 0] },
    ]);
    expect(a).toEqual(["clip:GateLeftVFC:west:0,0,0"]);
    expect(b).toEqual(["clip:GateRightVFC:east:0,0,0"]);
  });

  it("joins whatever way the pair is turned: gates laid flat and stacked along what was their height", () => {
    // RHEVARA's reset floor: gates pitched 90 degrees, 8 m apart — top bar against foot.
    const flat: Vec3 = [0, Math.PI / 2, 0];
    const up = freeClipFaces("probe", [0, 0, 0], flat, gate()).find((f) => f.clip.face === "top")!.normal;
    const step: Vec3 = [up[0] * 8, up[1] * 8, up[2] * 8];
    const [a, b] = hiddenOf([
      { id: "a", pos: [500, 200, 400], rot: flat },
      { id: "b", pos: [500 + step[0], 200 + step[1], 400 + step[2]], rot: flat },
    ]);
    expect(a).toEqual(["clip:GateFCT:top:0,0,0"]);
    expect(b).toEqual(["clip:GateFCB:bottom:0,0,0"]);
  });

  it("does not join across a gap, or clips that do not mate", () => {
    expect(hiddenOf([
      { id: "a", pos: [100, 50, 100], rot: [0, 0, 0] },
      { id: "b", pos: [140, 50, 100], rot: [0, 0, 0] }, // 8 m apart
    ])).toEqual([[], []]);
    // Turned half round, b shows a its Left post again: Left does not mate Left.
    expect(hiddenOf([
      { id: "a", pos: [100, 50, 100], rot: [0, 0, 0] },
      { id: "b", pos: [164, 50, 132], rot: [Math.PI, 0, 0] },
    ])).toEqual([[], []]);
  });

  it("a grid block's faces sit where a free block's would at the same spot", () => {
    const grid = gridClipFaces("g", { coord: [3, 6, 3], dir: 0 }, gate());
    const free = freeClipFaces("f", [96, 48, 96], [0, 0, 0], gate());
    for (const f of free) {
      const g = grid.find((x) => x.clip.id === f.clip.id)!;
      expect(g.centre.map((v) => Math.round(v))).toEqual(f.centre.map((v) => Math.round(v)));
      expect(g.normal.map((v) => Math.round(v))).toEqual(f.normal.map((v) => Math.round(v)));
    }
  });
});
