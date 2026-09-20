import { describe, expect, it } from "vitest";
import type { Vec3 } from "./math";
import { splitGhostRuns } from "./ghostRuns";

/** Points along x at 30 m steps from `x0`, one sample per 100 ms from `t0`. */
const drive = (x0: number, n: number, t0: number): { pts: Vec3[]; ts: number[] } => ({
  pts: Array.from({ length: n }, (_, i) => [x0 + i * 30, 0, 0] as Vec3),
  ts: Array.from({ length: n }, (_, i) => t0 + i * 100),
});

describe("splitGhostRuns", () => {
  // Start at x=0. CP1 at x=150 (t=500). Two failed tries at the jump after it, each respawning
  // at CP1 (a 90 m teleport back), then a clean run to the finish.
  const a = drive(0, 9, 0);        // 0..240: takes CP1 at t=500, crashes at x=240
  const b = drive(150, 4, 1000);   // 150..240: fails again
  const c = drive(150, 11, 1500);  // 150..450: finish at t=2500
  const path = [...a.pts, ...b.pts, ...c.pts];
  const times = [...a.ts, ...b.ts, ...c.ts];
  const checkpoints = [500, 2500];

  it("keeps only what reached the next checkpoint as the line", () => {
    const { line, attempts } = splitGhostRuns(path, times, checkpoints);
    expect(line.map((r) => [r.points[0][0], r.points[r.points.length - 1][0]])).toEqual([[0, 150], [150, 450]]);
    // The rest of the first piece (150 -> 240, sharing the cut point) and the whole second try.
    expect(attempts.map((r) => [r.points[0][0], r.points[r.points.length - 1][0]])).toEqual([[150, 240], [150, 240]]);
  });

  it("remembers where each piece sits in the path", () => {
    const { line, attempts } = splitGhostRuns(path, times, checkpoints);
    expect(line.map((r) => r.start)).toEqual([0, 13]);
    expect(attempts.map((r) => r.start)).toEqual([5, 9]);
  });

  it("without sample or checkpoint times everything is the line, split at respawns", () => {
    expect(splitGhostRuns(path).attempts).toEqual([]);
    expect(splitGhostRuns(path).line.length).toBe(3);
    expect(splitGhostRuns(path, times, []).attempts).toEqual([]);
    expect(splitGhostRuns(path, times.slice(1), checkpoints).attempts).toEqual([]);
  });

  it("a run without respawns is one piece of line", () => {
    const clean = drive(0, 20, 0);
    const { line, attempts } = splitGhostRuns(clean.pts, clean.ts, [900, 1900]);
    expect(line.length).toBe(1);
    expect(line[0].points.length).toBe(20);
    expect(attempts).toEqual([]);
  });

  it("the last piece counts in full even when the recording stops short of a finish", () => {
    const { line, attempts } = splitGhostRuns([...a.pts, ...b.pts], [...a.ts, ...b.ts], [500]);
    expect(line.length).toBe(2);
    expect(attempts.length).toBe(1);
  });
});
