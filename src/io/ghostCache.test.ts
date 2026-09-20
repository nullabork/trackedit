import { describe, expect, it } from "vitest";
import { ageText, cacheGet, cachePut } from "./ghostCache";

describe("ghost cache", () => {
  it("is a miss, never an error, where IndexedDB does not exist", async () => {
    await expect(cachePut("lines", "k", { a: 1 })).resolves.toBeUndefined();
    await expect(cacheGet("lines", "k")).resolves.toBeNull();
  });

  it("says how old a saved list is", () => {
    const now = 1_000_000_000_000;
    expect(ageText(now - 20_000, now)).toBe("just now");
    expect(ageText(now - 12 * 60_000, now)).toBe("12 min ago");
    expect(ageText(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(ageText(now - 5 * 86_400_000, now)).toBe("5 days ago");
  });
});
