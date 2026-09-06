import { describe, expect, it } from "vitest";
import { blockDelta, blockKey, mergeBlockDelta, normalizeBlock, validateSyncBlock, verifyBlockReadback } from "./liveSync";

const block = (x: number) => normalizeBlock({ name: "RoadTechStraight", coord: [x, 8, 1] });

describe("block synchronization", () => {
  it("accepts the recorded same-cell PlatformBase replacement resolving back to variant 2", () => {
    const requested = normalizeBlock({ name: "PlatformBase", coord: [5, 18, 42] });
    const actual = { ...requested, variant: 2, autoVariant: false, mobilVariant: 0 };
    expect(() => verifyBlockReadback([actual], [actual], { remove: [actual], add: [requested] })).not.toThrow();
    expect(() => verifyBlockReadback([actual], [], { remove: [actual], add: [requested] })).toThrow();
  });
  it("rejects failed deletions, extra duplicates, and wrong explicit variants", () => {
    const a = { ...block(1), variant: 2, autoVariant: false, mobilVariant: 0 };
    expect(() => verifyBlockReadback([a], [a], { remove: [a], add: [] })).toThrow();
    expect(() => verifyBlockReadback([], [a, a], { remove: [], add: [block(1)] })).toThrow();
    expect(() => verifyBlockReadback([], [{ ...a, variant: 3 }], { remove: [], add: [a] })).toThrow();
  });
  it("matches automatic and explicit duplicates individually while allowing unrelated generated blocks", () => {
    const a = { ...block(1), variant: 2, autoVariant: false, mobilVariant: 0 };
    const b = { ...a, variant: 3 };
    expect(() => verifyBlockReadback([], [a, b, block(9)], { remove: [], add: [block(1), a] })).not.toThrow();
  });
  it("lets new blocks choose a variant while preserving explicit imported variants", () => {
    expect(block(1).autoVariant).toBe(true);
    expect(normalizeBlock({ ...block(1), variant: 2, autoVariant: false }).autoVariant).toBe(false);
    expect(normalizeBlock({ name: "PlatformBase", coord: [11, 8, 33], variant: 0 }).autoVariant).toBe(false);
    expect(normalizeBlock(block(1)).autoVariant).toBe(true);
  });
  it("merges independent edits without replacing the whole map", () => {
    const a = block(1), b = block(2), c = block(3), d = block(4);
    const delta = blockDelta([a, b], [a, c]);
    expect(mergeBlockDelta([a, b, d], delta)).toEqual([a, d, c]);
  });
  it("counts duplicate blocks separately", () => {
    const a = block(1);
    expect(blockDelta([a, a], [a])).toEqual({ remove: [a], add: [] });
    expect(mergeBlockDelta([a, a, a], blockDelta([a, a], [a]))).toEqual([a, a]);
  });
  it("stops conflicting replacements rather than resurrecting a remote deletion", () => {
    expect(() => mergeBlockDelta([], blockDelta([block(1)], [block(2)]))).toThrow("both editors");
  });
  it("ignores field ordering and tiny free-position noise", () => {
    const a = normalizeBlock({ name: "A", isFree: true, absPos: [0.123456, 1, 2] });
    const b = normalizeBlock({ absPos: [0.123457, 1, 2], isFree: true, name: "A", irrelevant: true });
    expect(blockKey(a)).toBe(blockKey(b));
    expect(blockDelta([a], [b])).toEqual({ add: [], remove: [] });
  });
  it("protects skinned records against destructive reconstruction", () => {
    const a = { ...block(1), protected: true };
    expect(() => mergeBlockDelta([a], { remove: [a], add: [] })).toThrow("skin");
  });
  it("rejects invalid wire records", () => {
    expect(() => validateSyncBlock(block(1))).not.toThrow();
    expect(() => validateSyncBlock({ ...block(1), absPos: [NaN, 0, 0] })).toThrow("coordinates");
    expect(() => validateSyncBlock({ ...block(1), color: "unknown" })).toThrow("color");
    expect(() => validateSyncBlock({ ...block(1), waypoint: { tag: "a", order: -1 } })).toThrow("waypoint");
  });
});
