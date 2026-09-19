/**
 * A map's custom sky and light: where the sun is and what colour it is, fog,
 * and a sky image. Pure data — the renderer previews it, and saving to the
 * game writes it as a mood mod plus a MediaTracker fog clip
 * (tools/gameBridge.ts). Everything is optional: null means "the mood's own".
 */
import { SUNRISE01, SUNSET01, solveSun, sunDirection, type SunSettings } from "./sun";
import type { Vec3 } from "./math";

export interface CustomSun extends SunSettings {
  /** #rrggbb; null keeps the mood's own sun colour. */
  color: string | null;
  /** Brightness multiplier on the mood's own sun. */
  intensity: number;
  /** The moon sits opposite the sun. null keeps the mood's own colour. */
  moonColor: string | null;
  moonIntensity: number;
}

export interface CustomFog {
  /** #rrggbb */
  color: string;
  /** 0..1: how strongly the fog colours distant geometry. */
  intensity: number;
  /** 0..1: how much of the fog colour tints the sky itself. */
  skyIntensity: number;
  /** Metres until the fog is at full strength. */
  distance: number;
  /** 0..1 */
  cloudsOpacity: number;
}

export interface CustomSky {
  /** File name under the dev server's sky store (maps/sky). */
  image: string;
  /** HDR scale applied to the image. */
  exposure: number;
  /** Keep the mood's cloud layer over the image, or clear it. */
  clouds: "keep" | "clear";
}

export interface Atmosphere {
  sun: CustomSun | null;
  fog: CustomFog | null;
  sky: CustomSky | null;
}

export const EMPTY_ATMOSPHERE: Atmosphere = { sun: null, fog: null, sky: null };

export const DEFAULT_FOG: CustomFog = { color: "#c8d4e0", intensity: 0.5, skyIntensity: 0.5, distance: 6000, cloudsOpacity: 1 };

/** The game's own sun per mood (Media/Moods/<Mood>/Mood.MoodSetting.xml). Night is lit by the moon. */
export const MOOD_SUNS: Record<string, SunSettings> = {
  Sunrise: { dayTime01: 0.52, latitude: 45 },
  Day: { dayTime01: 0.6, latitude: 45 },
  Sunset: { dayTime01: 0.73, latitude: 45 },
  Night: { dayTime01: 0.15, latitude: 45 },
};

export function isDaylight(s: SunSettings): boolean {
  return s.dayTime01 >= SUNRISE01 && s.dayTime01 <= SUNSET01;
}

export function customSunFrom(settings: SunSettings, base?: CustomSun | null): CustomSun {
  return {
    color: base?.color ?? null,
    intensity: base?.intensity ?? 1,
    moonColor: base?.moonColor ?? null,
    moonIntensity: base?.moonIntensity ?? 1,
    dayTime01: settings.dayTime01,
    latitude: settings.latitude,
  };
}

/** Lowest sun the tool allows: at 0 the settings stop being solvable. */
export const MIN_SUN_ALTITUDE = 1;

/**
 * Compass reading of a direction: heading in degrees clockwise from the
 * game's North (+Z; East is -X) and height above the horizon.
 */
export function headingAltitude(dir: Vec3): { heading: number; altitude: number } {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const heading = (Math.atan2(-dir[0], dir[2]) * 180) / Math.PI;
  return { heading: (heading + 360) % 360, altitude: (Math.asin(dir[1] / len) * 180) / Math.PI };
}

export function directionFrom(heading: number, altitude: number): Vec3 {
  const h = (heading * Math.PI) / 180, a = (altitude * Math.PI) / 180;
  return [-Math.sin(h) * Math.cos(a), Math.sin(a), Math.cos(h) * Math.cos(a)];
}

/** Sun settings for a compass heading/height (height clamped above the horizon). */
export function sunFromHeading(heading: number, altitude: number): SunSettings {
  const alt = Math.min(90, Math.max(MIN_SUN_ALTITUDE, altitude));
  return solveSun(directionFrom(heading, alt))!;
}

/** Where the light comes from for a mood, custom sun or not. Night's own light is not modelled: it gets the Day arc's mirror. */
export function lightDirection(mood: string, sun: CustomSun | null): Vec3 {
  if (sun) return sunDirection(sun);
  const own = MOOD_SUNS[mood] ?? MOOD_SUNS.Day;
  return isDaylight(own) ? sunDirection(own) : [0.3, 1, 0.5];
}

/** The map's-clock reading of DayTime01 (06:00 sunrise .. 21:00 sunset), as "HH:MM". */
export function clockOf(dayTime01: number): string {
  const hours = 6 + ((dayTime01 - SUNRISE01) / (SUNSET01 - SUNRISE01)) * 15;
  const h = Math.floor(hours), m = Math.round((hours - h) * 60);
  return `${String(h + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function cloneAtmosphere(a: Atmosphere | null | undefined): Atmosphere {
  return {
    sun: a?.sun ? { ...a.sun } : null,
    fog: a?.fog ? { ...a.fog } : null,
    sky: a?.sky ? { ...a.sky } : null,
  };
}
