/**
 * Where the game puts the sun. Pure math, game coordinates (Y up).
 *
 * Measured in game (docs/NOTES-lightmap-baking.md, section 8): the sun runs
 * along a great circle. It rises due East (the game's East, -X) at
 * `DayTime01` 0.5 and sets due West at 0.75; `Latitude` tilts the circle
 * away from the zenith, towards South (-Z) when positive and North when
 * negative. Both are attributes of a mood's `Mood.MoodSetting.xml`, so any
 * direction above the horizon is one (dayTime01, latitude) pair.
 */
import { degToRad, type Vec3 } from "./math";

export const SUNRISE01 = 0.5;
export const SUNSET01 = 0.75;

const EAST: Vec3 = [-1, 0, 0];
const SOUTH: Vec3 = [0, 0, -1];

export interface SunSettings {
  dayTime01: number;
  /** Degrees, -90..90. */
  latitude: number;
}

/** Unit vector from the ground towards the sun. */
export function sunDirection({ dayTime01, latitude }: SunSettings): Vec3 {
  const t = ((dayTime01 - SUNRISE01) / (SUNSET01 - SUNRISE01)) * Math.PI;
  const lat = degToRad(latitude);
  const e = Math.cos(t), s = Math.sin(t) * Math.sin(lat), u = Math.sin(t) * Math.cos(lat);
  return [e * EAST[0] + s * SOUTH[0], u, e * EAST[2] + s * SOUTH[2]];
}

/** The settings that put the sun in `direction` (need not be unit length; has to point above the horizon). */
export function solveSun(direction: Vec3): SunSettings | null {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (len === 0 || direction[1] <= 0) return null;
  const e = (direction[0] * EAST[0] + direction[2] * EAST[2]) / len;
  const s = (direction[0] * SOUTH[0] + direction[2] * SOUTH[2]) / len;
  const u = direction[1] / len;
  const t = Math.acos(Math.min(1, Math.max(-1, e)));
  return {
    dayTime01: SUNRISE01 + (t / Math.PI) * (SUNSET01 - SUNRISE01),
    latitude: (Math.atan2(s, u) * 180) / Math.PI,
  };
}

/**
 * The map's own time of day (hours, 0..24) as DayTime01, for the daylight
 * part: the game's mood blender puts sunrise at 06:00 and sunset at 21:00
 * and runs the sun linearly between them. Null at night (not measured).
 */
export function dayTime01FromMapHours(hours: number, sunriseHour = 6, sunsetHour = 21): number | null {
  if (hours < sunriseHour || hours > sunsetHour) return null;
  return SUNRISE01 + ((hours - sunriseHour) / (sunsetHour - sunriseHour)) * (SUNSET01 - SUNRISE01);
}
