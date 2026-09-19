import { describe, expect, it } from "vitest";
import { createLayer, type Placement } from "./layer";
import type { Vec3 } from "./math";
import { WaypointTypes, linePasses, passesFromCheckpointTimes, waypointKind, waypointTagFor, waypointVolumes } from "./waypoints";

const types = new WaypointTypes({
  RoadTechStart: "Start",
  RoadTechCheckpoint: "Checkpoint",
  RoadTechFinish: "Finish",
  RoadTechMultilap: "StartFinish",
  "GateCheckpointCenter8m.Item.Gbx": "Checkpoint",
});

const block = (id: string, name: string, x: number, z: number, meta?: Record<string, unknown>): Placement =>
  ({ id, kind: "block", block: name, coord: [x, 9, z], dir: 0, ...(meta ? { meta } : {}) });

/** A straight drive along +x at road height through the middle of row z. */
const drive = (fromX: number, toX: number, z = 0, step = 8): Vec3[] => {
  const path: Vec3[] = [];
  for (let x = fromX; x <= toX; x += step) path.push([x, 9 * 8 + 3, z * 32 + 16]);
  return path;
};

const volumesOf = (placements: Placement[]) => {
  const layer = createLayer("L");
  for (const p of placements) layer.placements.set(p.id, p);
  return waypointVolumes([layer], types, () => [1, 1, 1]);
};

describe("waypoint kinds", () => {
  it("reads definition types and the tags maps store", () => {
    expect(waypointKind("Spawn")).toBe("start");
    expect(waypointKind("Goal")).toBe("finish");
    expect(waypointKind("LinkedCheckpoint")).toBe("checkpoint");
    expect(waypointKind("StartFinish")).toBe("multilap");
    expect(waypointKind("None")).toBeNull();
    expect(waypointTagFor("Start")).toBe("Spawn");
    expect(waypointTagFor("Finish")).toBe("Goal");
  });

  it("trusts a placement's own waypoint data, then its definition, never its name", () => {
    expect(types.kindOf(block("a", "DecoPlatformDirtSlope2Start", 0, 0))).toBeNull();
    expect(types.kindOf(block("b", "RoadTechCheckpoint", 0, 0))).toBe("checkpoint");
    expect(types.kindOf(block("c", "CustomThing", 0, 0, { waypoint: { tag: "Goal", order: 0 } }))).toBe("finish");
    expect(types.kindOf(block("d", "RoadTechCheckpoint", 0, 0, { waypoint: null }))).toBe("checkpoint");
    expect(types.typeOf("Nadeo/Gates/GateCheckpointCenter8m.Item.Gbx")).toBe("Checkpoint");
  });
});

describe("linePasses", () => {
  const track = [
    block("s", "RoadTechStart", 0, 0),
    block("road", "RoadTechStraight", 1, 0),
    block("c1", "RoadTechCheckpoint", 3, 0),
    block("c2", "RoadTechCheckpoint", 6, 0),
    block("off", "RoadTechCheckpoint", 4, 5),
    block("f", "RoadTechFinish", 9, 0),
  ];

  it("lists start, the checkpoints in driving order, and the finish", () => {
    const passes = linePasses(drive(16, 9 * 32 + 16), volumesOf(track));
    expect(passes.map((p) => p.label)).toEqual(["Start", "CP 1", "CP 2", "Finish"]);
    expect(passes.map((p) => p.placementId)).toEqual(["s", "c1", "c2", "f"]);
    expect(passes[1].pos[0]).toBeCloseTo(3 * 32 + 16, 0);
  });

  it("counts a checkpoint crossed between two samples", () => {
    // Clips the corner of CP 1's box: both samples are outside it.
    const passes = linePasses([[126, 75, -8], [134, 75, 8]], volumesOf(track));
    expect(passes.map((p) => p.placementId)).toEqual(["c1"]);
  });

  it("takes a checkpoint once, however often the line comes back or respawns onto it", () => {
    const there = drive(16, 7 * 32);
    const back = [...there].reverse();
    expect(linePasses([...there, ...back], volumesOf(track)).map((p) => p.label)).toEqual(["Start", "CP 1", "CP 2", "Start"]);
    // Drive past CP 1, respawn onto it (a 100 m jump), carry on to CP 2.
    const respawn: Vec3[] = [...drive(16, 6 * 32 + 16 - 32), [3 * 32 + 16, 75, 16], ...drive(3 * 32 + 24, 7 * 32)];
    expect(linePasses(respawn, volumesOf(track)).map((p) => p.label)).toEqual(["Start", "CP 1", "CP 2"]);
  });

  it("reports the time at each pass when the line has times", () => {
    const path = drive(16, 9 * 32 + 16);
    const passes = linePasses(path, volumesOf(track), path.map((_, i) => i * 50));
    expect(passes[0].timeMs).toBe(0);
    expect(passes[3].timeMs).toBeGreaterThan(passes[2].timeMs!);
  });

  it("gives a finished run its finish even when the finish trigger is bigger than its box", () => {
    const path = drive(16, 7 * 32); // stops two blocks short of the finish block
    expect(linePasses(path, volumesOf(track)).map((p) => p.label)).toEqual(["Start", "CP 1", "CP 2"]);
    const passes = linePasses(path, volumesOf(track), undefined, true);
    expect(passes.map((p) => p.label)).toEqual(["Start", "CP 1", "CP 2", "Finish"]);
    expect(passes[3].placementId).toBe("f");
    expect(passes[3].index).toBe(path.length - 1);
  });

  it("sizes an item checkpoint by its model, pivot and rotation", () => {
    // A 32 x 8 x 32 platform whose anchor is its far corner (pivot -16, -2, -16), yawed a quarter turn.
    const layer = createLayer("L");
    layer.placements.set("i", { id: "i", kind: "free", block: "GateCheckpointCenter8m.Item.Gbx", isItem: true, pos: [368, 122, 352], rot: [0, 0, 0], pivot: [-16, -2, -16] });
    const along: Vec3[] = [[340, 129, 300], [345, 129, 330], [350, 129, 360]];
    const guess = waypointVolumes([layer], types, () => undefined);
    const real = waypointVolumes([layer], types, () => undefined, () => ({ min: [-16, 0, -16], max: [16, 8, 16] }));
    expect(real[0].centre).toEqual([352, 124, 336]);
    expect(linePasses(along, real).map((p) => p.placementId)).toEqual(["i"]);
    // The car skirting the anchor corner is outside the model, whatever the gate-sized guess says.
    const skirting: Vec3[] = [[376, 123, 340], [376, 123, 350]];
    expect(linePasses(skirting, real)).toEqual([]);
    expect(guess[0].half[0]).toBeGreaterThan(real[0].half[0] - 1);
  });

  it("treats linked checkpoints as one", () => {
    const linked = (id: string, x: number) => block(id, "RoadTechCheckpoint", x, 0, { waypoint: { tag: "LinkedCheckpoint", order: 4 } });
    const passes = linePasses(drive(16, 9 * 32 + 16), volumesOf([block("s", "RoadTechStart", 0, 0), linked("a", 3), linked("b", 6), block("f", "RoadTechFinish", 9, 0)]));
    expect(passes.map((p) => p.placementId)).toEqual(["s", "a", "f"]);
  });

  it("follows a layer's transform and a multilap's first and last pass", () => {
    const layer = createLayer("moved");
    layer.transform = { translate: [0, 0, 320], rotDeg: [0, 0, 0] };
    layer.placements.set("m", block("m", "RoadTechMultilap", 0, 0));
    layer.placements.set("c", block("c", "RoadTechCheckpoint", 3, 0));
    const volumes = waypointVolumes([layer], types, () => [1, 1, 1]);
    const lap = drive(16, 5 * 32, 10);
    const out = [...lap, ...[...lap].reverse()];
    expect(linePasses(out, volumes).map((p) => p.label)).toEqual(["Start", "CP 1", "Finish"]);
    // Two laps: the multilap line gives the checkpoint back.
    expect(linePasses([...out, ...out], volumes).map((p) => p.label)).toEqual(["Start", "CP 1", "Lap 2", "CP 3", "Finish"]);
  });
});

describe("passesFromCheckpointTimes", () => {
  it("takes the count and order from the ghost, and the waypoint nearest each moment", () => {
    const linked = (id: string, z: number) => block(id, "RoadTechCheckpoint", 6, z, { waypoint: { tag: "LinkedCheckpoint", order: 1 } });
    const volumes = volumesOf([
      block("s", "RoadTechStart", 0, 0),
      block("c1", "RoadTechCheckpoint", 3, 0),
      linked("left", 0), linked("right", 4),
      block("f", "RoadTechFinish", 9, 3), // the run ends well short of it: a huge invisible trigger
    ]);
    // Drives 20 m to the side of everything: inside no box at all.
    const path: Vec3[] = [];
    for (let x = 16; x <= 8 * 32; x += 8) path.push([x, 75, 16 + 40]);
    const times = path.map((_, i) => i * 100);
    const at = (x: number) => times[path.findIndex((p) => p[0] >= x)];
    const passes = passesFromCheckpointTimes(path, times, [at(3 * 32 + 16), at(6 * 32 + 16), times[times.length - 1]], volumes);
    expect(passes.map((p) => p.label)).toEqual(["Start", "CP 1", "CP 2", "Finish"]);
    // z = 56 m is nearer the linked checkpoint in row 0 (0..32 m) than the one in row 4 (128..160 m).
    expect(passes.map((p) => p.placementId)).toEqual(["s", "c1", "left", "f"]);
    expect(passes[2].timeMs).toBe(at(6 * 32 + 16));
    expect(passes[3].index).toBe(path.length - 1);
  });
});
