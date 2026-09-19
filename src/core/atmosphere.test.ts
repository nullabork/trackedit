import { describe, expect, it } from "vitest";
import { clockOf, directionFrom, headingAltitude, isDownloadUrl, lightDirection, sunFromHeading } from "./atmosphere";
import { sunDirection } from "./sun";

describe("compass", () => {
  it("reads headings clockwise from the game's North (+Z), East being -X", () => {
    expect(headingAltitude([0, 0, 1]).heading).toBeCloseTo(0, 6);
    expect(headingAltitude([-1, 0, 0]).heading).toBeCloseTo(90, 6);
    expect(headingAltitude([0, 0, -1]).heading).toBeCloseTo(180, 6);
    expect(headingAltitude([1, 1, 0]).altitude).toBeCloseTo(45, 6);
  });

  it("round-trips heading/height through the sun settings", () => {
    for (const [heading, altitude] of [[120, 30], [300, 60], [180, 75], [90, 20], [10, 5]]) {
      const back = headingAltitude(sunDirection(sunFromHeading(heading, altitude)));
      expect(back.heading).toBeCloseTo(heading, 5);
      expect(back.altitude).toBeCloseTo(altitude, 5);
    }
  });

  it("keeps the sun above the horizon", () => {
    const low = headingAltitude(sunDirection(sunFromHeading(200, -30)));
    expect(low.altitude).toBeCloseTo(1, 5);
    expect(directionFrom(200, 1)[1]).toBeGreaterThan(0);
  });
});

describe("lightDirection", () => {
  it("uses the mood's own sun until a custom one is set", () => {
    const day = headingAltitude(lightDirection("Day", null));
    expect(day.heading).toBeCloseTo(90 + 65.3, 0);
    expect(day.altitude).toBeCloseTo(42.3, 0);
    const custom = lightDirection("Day", { dayTime01: 0.625, latitude: 0, color: null, intensity: 1, moonColor: null, moonIntensity: 1 });
    expect(custom[1]).toBeCloseTo(1, 6);
  });
});

describe("isDownloadUrl", () => {
  it("takes absolute web links only", () => {
    expect(isDownloadUrl("https://example.com/mods/TrackeditSun_ab_12.zip")).toBe(true);
    expect(isDownloadUrl("  http://files.example.org/x.zip ")).toBe(true);
    expect(isDownloadUrl("C:\\mods\\x.zip")).toBe(false);
    expect(isDownloadUrl("ftp://example.com/x.zip")).toBe(false);
    expect(isDownloadUrl("https://localhost/x.zip")).toBe(false);
    expect(isDownloadUrl("")).toBe(false);
  });
});

describe("clockOf", () => {
  it("maps the daylight arc onto 06:00..21:00", () => {
    expect(clockOf(0.5)).toBe("06:00");
    expect(clockOf(0.6)).toBe("12:00");
    expect(clockOf(0.75)).toBe("21:00");
  });
});
