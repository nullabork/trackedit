import { describe, expect, it } from "vitest";
import { PAINT_SLOTS, PALETTES, paintHex } from "./palettes";

describe("paintHex", () => {
  it("maps each slot to its palette column", () => {
    expect(paintHex("Classic", "White")).toBe(PALETTES.Classic[0]);
    expect(paintHex("Classic", "Black")).toBe(PALETTES.Classic[4]);
    expect(paintHex("Purple", "Green")).toBe(PALETTES.Purple[1]);
  });

  it("falls back to Classic for unknown palettes", () => {
    expect(paintHex("NotAPalette", "Red")).toBe(PALETTES.Classic[3]);
  });

  it("returns null for unknown slots", () => {
    expect(paintHex("Classic", "Chartreuse")).toBeNull();
  });
});

describe("palette table invariants", () => {
  it("every palette has exactly one shade per slot", () => {
    for (const [name, row] of Object.entries(PALETTES)) {
      expect(row, name).toHaveLength(PAINT_SLOTS.length);
      for (const hex of row) expect(hex, name).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("monochrome rows run light -> dark (White slot = lightest)", () => {
    // Perceived lightness must not increase along the row.
    const lum = (hex: string) =>
      0.299 * parseInt(hex.slice(1, 3), 16) +
      0.587 * parseInt(hex.slice(3, 5), 16) +
      0.114 * parseInt(hex.slice(5, 7), 16);
    for (const name of ["Red", "Blue", "Purple", "White", "Black"]) {
      const row = PALETTES[name];
      for (let i = 1; i < row.length; i++)
        expect(lum(row[i]), `${name}[${i}]`).toBeLessThan(lum(row[i - 1]));
    }
  });
});
