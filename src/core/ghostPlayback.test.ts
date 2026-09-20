import { describe, expect, it } from "vitest";
import type { Vec3 } from "./math";
import { buildTimeline, entryAt, sampleTimeline, stepTime } from "./ghostPlayback";

/** Points along x at 30 m steps from `x0`, one sample per 100 ms from `t0`. */
const drive = (x0: number, n: number, t0: number) => ({
  pts: Array.from({ length: n }, (_, i) => [x0 + i * 30, 0, 0] as Vec3),
  ts: Array.from({ length: n }, (_, i) => t0 + i * 100),
});

// Start at 0, CP1 at x=150 (t=500), crash at 240; one more failed try from CP1; then to the finish.
const a = drive(0, 9, 0), b = drive(150, 4, 1000), c = drive(150, 11, 1500);
const ghost = {
  path: [...a.pts, ...b.pts, ...c.pts],
  times: [...a.ts, ...b.ts, ...c.ts],
  checkpoints: [500, 2500],
  steer: [...a.pts, ...b.pts, ...c.pts].map((_, i) => (i % 2 ? 100 : -100)),
  gas: [...a.pts, ...b.pts, ...c.pts].map(() => 100),
  brake: [...a.pts, ...b.pts, ...c.pts].map(() => 0),
  speed: [...a.pts, ...b.pts, ...c.pts].map((_, i) => i),
};

describe("ghost playback", () => {
  const tl = buildTimeline(ghost);

  it("plays only what reached a checkpoint, back to back", () => {
    // 0..150 (6 samples, 500 ms) then 150..450 (11 samples, 1000 ms); the tries are gone.
    expect(tl.index.length).toBe(17);
    expect(tl.duration).toBe(1500);
    expect(tl.pieceStarts).toEqual([0, 6]);
    expect(tl.checkpoints).toEqual([500, 1500]);
  });

  it("samples position, direction, inputs and the race clock", () => {
    const s = sampleTimeline(ghost, tl, 250)!;
    expect(s.pos[0]).toBeCloseTo(75);
    expect(s.forward).toEqual([1, 0, 0]);
    expect(s.gas).toBe(1);
    expect(s.steer).toBeCloseTo(0); // halfway between full left and full right
    expect(s.raceTime).toBe(250);
    expect(s.checkpointsTaken).toBe(0);
  });

  it("the race clock jumps where tries were cut, and the car never blends across the cut", () => {
    const before = sampleTimeline(ghost, tl, 499)!, after = sampleTimeline(ghost, tl, 501)!;
    expect(before.pos[0]).toBeLessThanOrEqual(150);
    expect(after.pos[0]).toBeGreaterThanOrEqual(150);
    expect(after.raceTime).toBeGreaterThan(1500);
    expect(sampleTimeline(ghost, tl, 1500)!.checkpointsTaken).toBe(2);
  });

  it("clamps outside the run and survives a ghost without timing or inputs", () => {
    expect(sampleTimeline(ghost, tl, -50)!.pos[0]).toBe(0);
    expect(sampleTimeline(ghost, tl, 9e9)!.pos[0]).toBe(450);
    const bare = { path: a.pts };
    const t2 = buildTimeline(bare);
    expect(t2.duration).toBe(8 * 50);
    expect(sampleTimeline(bare, t2, 100)!.steer).toBeNull();
    expect(sampleTimeline({ path: [] as Vec3[] }, buildTimeline({ path: [] }), 0)).toBeNull();
  });

  it("hands back the car body's orientation, blended the short way round", () => {
    // Facing +z for the whole run except the very first sample, which is the same rotation
    // written with the opposite sign: blending the two must not swing through anything.
    const rot = ghost.path.flatMap((_, i) => (i === 0 ? [0, 0, 0, -1000] : [0, 0, 0, 1000]));
    const s = sampleTimeline({ ...ghost, rot }, tl, 50)!;
    expect(s.quat!.map((v) => Math.abs(Math.round(v * 1000)))).toEqual([0, 0, 0, 1000]);
    // A quarter turn about y at sample 2, none at sample 3: halfway is an eighth turn.
    const turning = ghost.path.flatMap((_, i) => (i === 2 ? [0, 707, 0, 707] : [0, 0, 0, 1000]));
    const q = sampleTimeline({ ...ghost, rot: turning }, tl, 250)!.quat!;
    expect(2 * Math.atan2(q[1], q[3]) * (180 / Math.PI)).toBeCloseTo(45, 0);
    expect(sampleTimeline(ghost, tl, 50)!.quat).toBeNull();
    expect(sampleTimeline({ ...ghost, rot: [0, 0, 0, 1000] }, tl, 50)!.quat).toBeNull(); // wrong length
  });

  it("steps sample by sample", () => {
    expect(entryAt(tl, 250)).toBe(2);
    expect(stepTime(tl, 250, 1)).toBe(300);
    expect(stepTime(tl, 250, -1)).toBe(200);
    expect(stepTime(tl, 200, -1)).toBe(100);
    expect(stepTime(tl, 0, -5)).toBe(0);
    expect(stepTime(tl, 1500, 5)).toBe(1500);
  });
});
