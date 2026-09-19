import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE, PAINT_SLOTS, PALETTE_NAMES, paintHex, setColorTables } from "./palettes";

describe("paintHex", () => {
  it("maps each slot to its palette column of the Default table", () => {
    expect(paintHex("Classic", "White")).toBe(DEFAULT_TABLE.Classic[0]);
    expect(paintHex("Classic", "Black")).toBe(DEFAULT_TABLE.Classic[4]);
    expect(paintHex("Purple", "Green")).toBe(DEFAULT_TABLE.Purple[1]);
    expect(paintHex("Orange", "Red")).toBe("#f97c00");
  });

  it("falls back to Classic for unknown palettes and to Default for unknown tables", () => {
    expect(paintHex("NotAPalette", "Red")).toBe(DEFAULT_TABLE.Classic[3]);
    expect(paintHex("Orange", "Red", "NotATable")).toBe(DEFAULT_TABLE.Orange[3]);
  });

  it("returns null for unknown slots", () => {
    expect(paintHex("Classic", "Chartreuse")).toBeNull();
  });

  it("uses a material's own table when the game tables are loaded", () => {
    setColorTables({ Sport: { Classic: ["#e1e1e1", "#437256", "#376088", "#8f291b", "#252525"] } });
    expect(paintHex("Classic", "Red", "Sport")).toBe("#8f291b");
    expect(paintHex("Classic", "Red")).toBe(DEFAULT_TABLE.Classic[3]);
    // A table without the palette row uses the Default table's row for it.
    expect(paintHex("Orange", "Red", "Sport")).toBe(DEFAULT_TABLE.Orange[3]);
  });
});

describe("palette table invariants", () => {
  it("every palette has exactly one shade per slot, in the map's index order", () => {
    expect(Object.keys(DEFAULT_TABLE)).toEqual([...PALETTE_NAMES]);
    for (const [name, row] of Object.entries(DEFAULT_TABLE)) {
      expect(row, name).toHaveLength(PAINT_SLOTS.length);
      for (const hex of row) expect(hex, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
