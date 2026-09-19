import { describe, expect, it } from "vitest";
import { dayTime01FromMapHours, solveSun, sunDirection } from "./sun";
import type { Vec3 } from "./math";

function expectVec(actual: Vec3, expected: Vec3): void {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
}

describe("sunDirection", () => {
  it("rises due East (-X) and sets due West at any latitude", () => {
    expectVec(sunDirection({ dayTime01: 0.5, latitude: 45 }), [-1, 0, 0]);
    expectVec(sunDirection({ dayTime01: 0.5, latitude: 85 }), [-1, 0, 0]);
    expectVec(sunDirection({ dayTime01: 0.75, latitude: -30 }), [1, 0, 0]);
  });

  it("stands due South at noon, 90 - latitude degrees up; North for a southern latitude", () => {
    const s = Math.SQRT1_2;
    expectVec(sunDirection({ dayTime01: 0.625, latitude: 45 }), [0, s, -s]);
    expectVec(sunDirection({ dayTime01: 0.625, latitude: -45 }), [0, s, s]);
    expectVec(sunDirection({ dayTime01: 0.625, latitude: 0 }), [0, 1, 0]);
  });

  it("matches the headings read in game for the stock Day mood", () => {
    // Day: 0.6 at latitude 45 -> about 65 degrees from East towards South, 42 up.
    const d = sunDirection({ dayTime01: 0.6, latitude: 45 });
    expect((Math.atan2(-d[2], -d[0]) * 180) / Math.PI).toBeCloseTo(65.3, 1);
    expect((Math.asin(d[1]) * 180) / Math.PI).toBeCloseTo(42.3, 1);
  });
});

describe("solveSun", () => {
  it("round-trips any direction above the horizon", () => {
    for (const settings of [
      { dayTime01: 0.55, latitude: 40 },
      { dayTime01: 0.7, latitude: -26.5 },
      { dayTime01: 0.625, latitude: 85 },
      { dayTime01: 0.51, latitude: -80 },
    ]) {
      const solved = solveSun(sunDirection(settings))!;
      expect(solved.dayTime01).toBeCloseTo(settings.dayTime01, 6);
      expect(solved.latitude).toBeCloseTo(settings.latitude, 6);
    }
  });

  it("accepts unnormalised directions and rejects the ground", () => {
    const solved = solveSun([0, 5, -5])!;
    expect(solved.dayTime01).toBeCloseTo(0.625, 6);
    expect(solved.latitude).toBeCloseTo(45, 6);
    expect(solveSun([1, 0, 0])).toBeNull();
    expect(solveSun([0, -1, 0])).toBeNull();
  });
});

describe("dayTime01FromMapHours", () => {
  it("runs the daylight hours from sunrise to sunset", () => {
    expect(dayTime01FromMapHours(6)).toBeCloseTo(0.5, 6);
    expect(dayTime01FromMapHours(12)).toBeCloseTo(0.6, 6);
    expect(dayTime01FromMapHours(18)).toBeCloseTo(0.7, 6);
    expect(dayTime01FromMapHours(21)).toBeCloseTo(0.75, 6);
    expect(dayTime01FromMapHours(3)).toBeNull();
  });
});
