import { describe, expect, it } from "vitest";
import {
  clipHiddenBy, clipsConnect, faceToward, hiddenClipParts, occupiedCells, rotateByDir, unitCell, unrotateByDir, withClipDefs,
} from "./clipAdjacency";
import type { BlockClipInfo, ClipSubject, UnitClip } from "./clipAdjacency";
import type { Dir, GridCoord } from "@core/math";

const G = "PlatformFCSmallClips";
const cruise = (): BlockClipInfo => ({
  size: [1, 1, 1],
  units: [[0, 0, 0]],
  clips: [
    { u: [0, 0, 0], face: "north", id: "PlatformFCSmall", group: G },
    { u: [0, 0, 0], face: "south", id: "PlatformFCSmall", group: G },
    { u: [0, 0, 0], face: "east", id: "PlatformSpecialFCRight", group: G },
    { u: [0, 0, 0], face: "west", id: "PlatformSpecialFCLeft", group: G },
    { u: [0, 0, 0], face: "bottom", id: "PlatformBaseFCB", group: "PlatformBaseFCB", sym: "PlatformBaseFCT" },
  ],
});
const at = (coord: GridCoord, dir: Dir, info = cruise()): ClipSubject => ({ pose: { coord, dir }, info });
const world = (...subjects: ClipSubject[]) => (cell: GridCoord) =>
  subjects.filter((s) => occupiedCells(s).some((c) => c[0] === cell[0] && c[1] === cell[1] && c[2] === cell[2]));

describe("dir rotation", () => {
  it("turns block-local axes the way the renderer yaws blocks", () => {
    expect(rotateByDir([0, 0, 1], 0)).toEqual([0, 0, 1]);
    expect(rotateByDir([0, 0, 1], 1)).toEqual([-1, 0, 0]);
    expect(rotateByDir([0, 0, 1], 2)).toEqual([0, 0, -1]);
    expect(rotateByDir([0, 0, 1], 3)).toEqual([1, 0, 0]);
    for (const d of [0, 1, 2, 3] as Dir[]) expect(unrotateByDir(rotateByDir([-1, 0, 0], d), d)).toEqual([-1, 0, 0]);
  });

  it("names the face that looks along a direction", () => {
    expect(faceToward([0, 0, 1], 0)).toBe("north");
    expect(faceToward([-1, 0, 0], 0)).toBe("east");
    expect(faceToward([-1, 0, 0], 1)).toBe("north");
    expect(faceToward([0, 1, 0], 3)).toBe("top");
  });
});

describe("unit cells", () => {
  it("a 1-cell block occupies its coord whatever its dir", () => {
    for (const d of [0, 1, 2, 3] as Dir[]) expect(unitCell({ coord: [8, 17, 20], dir: d }, [1, 1, 1], [0, 0, 0])).toEqual([8, 17, 20]);
  });

  it("a 2x1 block turned once extends along +z from its coord", () => {
    const size: [number, number, number] = [2, 1, 1];
    expect(unitCell({ coord: [5, 0, 5], dir: 0 }, size, [1, 0, 0])).toEqual([6, 0, 5]);
    expect(unitCell({ coord: [5, 0, 5], dir: 1 }, size, [1, 0, 0])).toEqual([5, 0, 6]);
    expect(unitCell({ coord: [5, 0, 5], dir: 2 }, size, [1, 0, 0])).toEqual([5, 0, 5]);
    expect(unitCell({ coord: [5, 0, 5], dir: 2 }, size, [0, 0, 0])).toEqual([6, 0, 5]);
  });
});

describe("clip mating (the game's definition fields)", () => {
  const clip = (id: string, def: Partial<UnitClip> = {}): UnitClip => ({ u: [0, 0, 0], face: "east", id, ...def });
  it("a shared group mates", () => {
    const wall = clip("DecoWallBaseVFC", { group: "DecoWallBaseVFC" });
    expect(clipsConnect(wall, clip("PlatformBaseVFC", { group: "DecoWallBaseVFC" }))).toBe(true);
    expect(clipsConnect(wall, clip("Other", { group: "g2" }))).toBe(false);
    // The clip's OWN definition decides; what the other one asks for does not matter.
    expect(clipsConnect(clip("PlatformDiag1FCLeft", { group: "Small" }), clip("PlatformWaterFCSmall", { group: "Small", sym: "Small" }))).toBe(true);
  });
  it("a symmetrical group mates with THAT group only: top plate with underside, not with another top plate", () => {
    const top = clip("PlatformBaseFCT", { group: "PlatformBaseFCT", sym: "PlatformBaseFCB" });
    expect(clipsConnect(top, clip("PlatformBaseFCB", { group: "PlatformBaseFCB", sym: "PlatformBaseFCT" }))).toBe(true);
    expect(clipsConnect(top, top)).toBe(false);
  });
  it("an asymmetrical clip mates with exactly its partner: Left with Right", () => {
    const left = clip("DecoWallCurve1FCT", { asym: "DecoWallCurve1FCB" });
    expect(clipsConnect(left, clip("DecoWallCurve1FCB", { asym: "DecoWallCurve1FCT" }))).toBe(true);
    expect(clipsConnect(left, left)).toBe(false);
  });
  it("without any of these fields a clip mates with itself", () => {
    expect(clipsConnect(clip("A"), clip("A"))).toBe(true);
    expect(clipsConnect(clip("A"), clip("B"))).toBe(false);
  });
  it("a full free clip deletes a deletable clip facing it — and only that way round", () => {
    const full = clip("DecoWallBaseVFC", { group: "DecoWallBaseVFC", full: true, deletable: true });
    const trim = clip("SomeTrim", { deletable: true });
    const panel = clip("DecoWallLoopEndVFCLeft", { group: "DecoWallLoopEndVFCLeft", sym: "DecoWallLoopEndVFCRight" });
    expect(clipHiddenBy(trim, full)).toBe(true);
    expect(clipHiddenBy(full, trim)).toBe(false);
    // A full wall and a partial panel both stay (the game keeps 100% of these).
    expect(clipHiddenBy(full, panel)).toBe(false);
    expect(clipHiddenBy(panel, full)).toBe(false);
  });
  it("definitions replace whatever index.json guessed", () => {
    const guessed: UnitClip = { u: [0, 3, 0], face: "east", id: "DecoWallLoopEndVFCLeft", group: "DecoWallBaseVFC", sym: "DecoWallBaseVFC", vertical: true };
    expect(withClipDefs([guessed], { DecoWallLoopEndVFCLeft: { group: "DecoWallLoopEndVFCLeft", sym: "DecoWallLoopEndVFCRight" } }))
      .toEqual([{ u: [0, 3, 0], face: "east", id: "DecoWallLoopEndVFCLeft", vertical: true, group: "DecoWallLoopEndVFCLeft", sym: "DecoWallLoopEndVFCRight" }]);
    expect(withClipDefs([guessed], {})).toEqual([{ u: [0, 3, 0], face: "east", id: "DecoWallLoopEndVFCLeft", vertical: true }]);
  });
});

describe("hidden clip parts", () => {
  it("a lone block keeps every cap", () => {
    const s = at([8, 17, 20], 3);
    expect(hiddenClipParts(s, world(s)).size).toBe(0);
  });

  it("three cruise platforms in a row hide the turbines between them, not at the ends", () => {
    // TMX #84442: dir 3 along +z, coords z = 19, 20, 21. Local east/west
    // (the turbine faces) point along z after the quarter turns.
    const a = at([8, 17, 19], 3), b = at([8, 17, 20], 3), c = at([8, 17, 21], 3);
    const w = world(a, b, c);
    const mid = hiddenClipParts(b, w);
    expect([...mid].sort()).toEqual([
      "clip:PlatformSpecialFCLeft:west:0,0,0",
      "clip:PlatformSpecialFCRight:east:0,0,0",
    ]);
    expect(hiddenClipParts(a, w).size).toBe(1);
    expect(hiddenClipParts(c, w).size).toBe(1);
    // The sideways edge trims stay: nothing sits beside the run.
    expect([...hiddenClipParts(a, w)].some((p) => p.includes("PlatformFCSmall"))).toBe(false);
  });

  it("a base underside joins the top-cap group of the block below", () => {
    const upper = at([2, 5, 2], 0);
    const lowerInfo: BlockClipInfo = {
      size: [1, 1, 1], units: [[0, 0, 0]],
      clips: [{ u: [0, 0, 0], face: "top", id: "PlatformBaseFCT", group: "PlatformBaseFCT" }],
    };
    const lower = at([2, 4, 2], 0, lowerInfo);
    expect([...hiddenClipParts(upper, world(upper, lower))]).toEqual(["clip:PlatformBaseFCB:bottom:0,0,0"]);
  });

  it("different groups stay open", () => {
    const a = at([0, 0, 0], 0);
    const other: BlockClipInfo = { size: [1, 1, 1], units: [[0, 0, 0]], clips: [{ u: [0, 0, 0], face: "south", id: "RoadClip", group: "RoadClips" }] };
    const b = at([0, 0, 1], 0, other);
    expect(hiddenClipParts(a, world(a, b)).size).toBe(0);
  });
});

describe("caps inside another block", () => {
  const wallSlope = (): BlockClipInfo => ({
    size: [1, 2, 1],
    units: [[0, 0, 0], [0, 1, 0]],
    clips: [
      { u: [0, 0, 0], face: "bottom", id: "PlatformBaseFCB", group: "PlatformBaseFCB", sym: "PlatformBaseFCT" },
      { u: [0, 1, 0], face: "top", id: "DecoWallSlope2StraightFCT" },
      { u: [0, 0, 0], face: "west", id: "DecoWallBaseVFC", group: "DecoWallBaseVFC", vertical: true },
    ],
  });
  /** A snow hill: three cells tall, no clips at all. */
  const hill = (): BlockClipInfo => ({ size: [1, 3, 1], units: [[0, 0, 0], [0, 1, 0], [0, 2, 0]], clips: [] });

  it("shows both caps of a block standing alone", () => {
    const wall = at([9, 20, 16], 0, wallSlope());
    expect(hiddenClipParts(wall, world(wall))).toEqual(new Set());
  });

  it("keeps a cap that another block overlaps", () => {
    // RHEVARA: a hill shares the deco-wall slope's cells and reaches one cell higher.
    // We used to drop the wall's top plate here; the game's baked clips keep it in
    // 500 of 500 such cases — only a mating clip removes a cap.
    const wall = at([9, 20, 16], 0, wallSlope());
    const snow = at([9, 20, 16], 3, hill());
    expect(hiddenClipParts(wall, (cell) => world(snow)(cell))).toEqual(new Set());
  });

  it("keeps a cap over a mere neighbour that does not join it", () => {
    // RHEVARA again: an arch's underside IS the arch; a platform in the cell
    // below must not remove it.
    const wall = at([9, 20, 16], 0, wallSlope());
    const below = at([9, 17, 16], 2, hill()); // fills 17..19, not the wall's own cells
    expect(hiddenClipParts(wall, (cell) => world(below)(cell))).toEqual(new Set());
    const neighbour = at([10, 20, 16], 0, hill()); // beside it: side walls stay too
    expect(hiddenClipParts(wall, (cell) => world(neighbour)(cell))).toEqual(new Set());
  });
});
