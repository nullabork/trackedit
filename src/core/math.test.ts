import { describe, expect, it } from "vitest";
import {
  clampCoord,
  degToRad,
  eulerYXZFromQuat,
  quatFromEulerYXZ,
  quatMul,
  quatRotate,
  QUAT_IDENTITY,
  rotateDir,
  type Dir,
  type Vec3,
} from "./math";

describe("rotateDir", () => {
  it("wraps quarter turns in both directions", () => {
    expect(rotateDir(0, 1)).toBe(1);
    expect(rotateDir(3, 1)).toBe(0);
    expect(rotateDir(0, -1)).toBe(3);
    expect(rotateDir(2, 6)).toBe(0);
    for (const d of [0, 1, 2, 3] as Dir[]) expect(rotateDir(d, 4)).toBe(d);
  });
});

describe("clampCoord", () => {
  it("clamps into the map size (cells are 0..size-1)", () => {
    expect(clampCoord([-5, 2, 99], [48, 40, 48])).toEqual([0, 2, 47]);
    expect(clampCoord([10, 10, 10], [48, 40, 48])).toEqual([10, 10, 10]);
  });
});

describe("quaternions (three.js YXZ conventions)", () => {
  const close = (a: Vec3, b: Vec3) => {
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 10);
  };

  it("identity leaves vectors alone", () => {
    close(quatRotate(QUAT_IDENTITY, [1, 2, 3]), [1, 2, 3]);
  });

  it("yaw 90° about +Y sends +X to -Z (right-handed)", () => {
    const q = quatFromEulerYXZ([0, degToRad(90), 0]);
    close(quatRotate(q, [1, 0, 0]), [0, 0, -1]);
    close(quatRotate(q, [0, 1, 0]), [0, 1, 0]);
  });

  it("pitch 90° about +X sends +Y to +Z", () => {
    const q = quatFromEulerYXZ([degToRad(90), 0, 0]);
    close(quatRotate(q, [0, 1, 0]), [0, 0, 1]);
  });

  it("euler -> quat -> euler roundtrips", () => {
    const e: Vec3 = [degToRad(25), degToRad(-70), degToRad(10)];
    const back = eulerYXZFromQuat(quatFromEulerYXZ(e));
    close(back, e);
  });

  it("composition matches applying rotations in sequence", () => {
    const yaw = quatFromEulerYXZ([0, degToRad(90), 0]);
    const pitch = quatFromEulerYXZ([degToRad(90), 0, 0]);
    const both = quatMul(yaw, pitch);
    const v: Vec3 = [0, 0, 1];
    close(quatRotate(both, v), quatRotate(yaw, quatRotate(pitch, v)));
  });
});
