import { describe, expect, it } from "vitest";
import { clampTransformToBase, createLayer, isIdentityTransform, type LayerTransform } from "./layer";

const SIZE = 48 * 32; // 48-cell world edge in metres

describe("clampTransformToBase", () => {
  it("leaves transforms at or above the base untouched (same object)", () => {
    const t: LayerTransform = { translate: [10, 5, -20], rotDeg: [0, 0, 0] };
    expect(clampTransformToBase(t, SIZE, SIZE)).toBe(t);
  });

  it("stops plain downward translation below the base", () => {
    const t: LayerTransform = { translate: [0, -100, 0], rotDeg: [0, 0, 0] };
    expect(clampTransformToBase(t, SIZE, SIZE).translate[1]).toBe(0);
  });

  it("auto-lifts a tilted plane so its lowest corner sits at base level", () => {
    // Rolling about Z dips the far-X edge by sin(25°) * width.
    const t: LayerTransform = { translate: [0, 0, 0], rotDeg: [0, 0, -25] };
    const clamped = clampTransformToBase(t, SIZE, SIZE);
    expect(clamped.rotDeg).toEqual([0, 0, -25]); // keeps rotating
    expect(clamped.translate[1]).toBeCloseTo(SIZE * Math.sin((25 * Math.PI) / 180), 6);
  });

  it("does not lift when the existing translation already compensates", () => {
    const lift = SIZE * Math.sin((25 * Math.PI) / 180) + 1;
    const t: LayerTransform = { translate: [0, lift, 0], rotDeg: [0, 0, -25] };
    expect(clampTransformToBase(t, SIZE, SIZE)).toBe(t);
  });
});

describe("createLayer", () => {
  it("starts identity, visible, unlocked, with the native grid", () => {
    const layer = createLayer("Test");
    expect(isIdentityTransform(layer.transform)).toBe(true);
    expect(layer.visible).toBe(true);
    expect(layer.locked).toBe(false);
    expect(layer.settings.gridStep).toEqual([32, 8, 32]);
    expect(layer.placements.size).toBe(0);
  });

  it("gives every layer a unique id", () => {
    expect(createLayer("a").id).not.toBe(createLayer("a").id);
  });
});
