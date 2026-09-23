import type { GhostPath } from "./layer";
import type { Vec3 } from "./math";
import { splitGhostRuns } from "./ghostRuns";

/**
 * Playing a driving line back: a TIMELINE of the run as it counts.
 *
 * Only the pieces that reached the next checkpoint or the finish are on it
 * (core/ghostRuns) — a run with 489 thrown-away tries plays as the 46 pieces
 * that got somewhere, back to back. Playback time therefore is not race time:
 * it advances only while the car is on the line, and the race time of the
 * sample under the cursor is reported alongside (it jumps where tries were cut).
 *
 * Pure: the viewport, the scrubber and the camera all read `sampleTimeline`.
 */
export interface PlaybackTimeline {
  /** Indices into the ghost's arrays, in playing order. */
  index: number[];
  /** Playback time (ms) of each entry: monotonic, starting at 0. */
  t: number[];
  /** Entry at which each piece starts (the car jumps there: a respawn was cut out). */
  pieceStarts: number[];
  /** Playback time of each checkpoint the run took, the finish last. */
  checkpoints: number[];
  duration: number;
}

export interface PlaybackSample {
  pos: Vec3;
  /** Unit vector the car travels along (layer-local). */
  forward: Vec3;
  /**
   * The car body's orientation (x, y, z, w; forward = +z), when the ghost has it. Differs
   * from `forward` whenever the car slides.
   */
  quat: [number, number, number, number] | null;
  /** -1 (full left) .. 1 (full right); null when the ghost has no inputs. */
  steer: number | null;
  /** 0..1 */
  gas: number | null;
  /** 0..1 */
  brake: number | null;
  /** km/h */
  speed: number | null;
  /** Per wheel (FL, FR, RL, RR): angle in radians (cumulative) and damper extension in metres; null without the data. */
  wheelRot: [number, number, number, number] | null;
  damper: [number, number, number, number] | null;
  /** The race clock at this point (ms). */
  raceTime: number;
  /** How many checkpoints have been taken by now. */
  checkpointsTaken: number;
  /** Entry of the timeline at or before the cursor. */
  entry: number;
}

/** The game keeps a wheel's angle modulo 256 turns (milliradians here). */
const WHEEL_WRAP = 256 * 2 * Math.PI * 1000;

/** Ghosts are sampled at 20 Hz; without sample times, assume that. */
const DEFAULT_STEP_MS = 50;

export function buildTimeline(ghost: Pick<GhostPath, "path" | "times" | "checkpoints">): PlaybackTimeline {
  const timed = ghost.times?.length === ghost.path.length;
  const timeOf = (i: number) => (timed ? ghost.times![i] : i * DEFAULT_STEP_MS);
  const index: number[] = [], t: number[] = [], pieceStarts: number[] = [];
  let clock = 0;
  for (const run of splitGhostRuns(ghost.path, ghost.times, ghost.checkpoints).line) {
    pieceStarts.push(index.length);
    // Consecutive pieces share the sample they were cut at: do not play it twice.
    const from = index.length && index[index.length - 1] === run.start ? 1 : 0;
    for (let k = from; k < run.points.length; k++) {
      const i = run.start + k;
      if (k > 0) clock += Math.max(0, timeOf(i) - timeOf(i - 1));
      index.push(i);
      t.push(clock);
    }
  }
  // A checkpoint's race time -> the playback time of the first entry at or after it.
  const checkpoints: number[] = [];
  if (timed) {
    let e = 0;
    for (const cp of ghost.checkpoints ?? []) {
      while (e < index.length - 1 && timeOf(index[e]) < cp) e++;
      checkpoints.push(t[e] ?? 0);
    }
  }
  return { index, t, pieceStarts, checkpoints, duration: t.length ? t[t.length - 1] : 0 };
}

/** Entry at or before playback time `ms` (binary search). */
export function entryAt(timeline: PlaybackTimeline, ms: number): number {
  const { t } = timeline;
  let lo = 0, hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= ms) lo = mid; else hi = mid - 1;
  }
  return Math.max(0, lo);
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export function sampleTimeline(
  ghost: Pick<GhostPath, "path" | "times" | "checkpoints" | "steer" | "gas" | "brake" | "speed" | "rot" | "wheelRot" | "damper">,
  timeline: PlaybackTimeline,
  ms: number,
): PlaybackSample | null {
  const n = timeline.index.length;
  if (!n) return null;
  const clamped = Math.min(Math.max(ms, 0), timeline.duration);
  const e = entryAt(timeline, clamped);
  const next = Math.min(e + 1, n - 1);
  // Never blend across a cut: the car did not drive from one piece to the next.
  const cut = timeline.pieceStarts.includes(next) && next !== e;
  const span = timeline.t[next] - timeline.t[e];
  const k = cut || span <= 0 ? 0 : (clamped - timeline.t[e]) / span;
  const i = timeline.index[e], j = cut ? i : timeline.index[next];
  const a = ghost.path[i], b = ghost.path[j];
  const pos: Vec3 = [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

  // Direction of travel: across a few samples either side, inside the piece, so it neither
  // jitters at 20 Hz nor points along a respawn jump.
  const pieceStart = [...timeline.pieceStarts].reverse().find((s) => s <= e) ?? 0;
  const pieceEnd = (timeline.pieceStarts.find((s) => s > e) ?? n) - 1;
  const from = ghost.path[timeline.index[Math.max(pieceStart, e - 2)]];
  const to = ghost.path[timeline.index[Math.min(pieceEnd, e + 3)]];
  let f: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(f[0], f[1], f[2]);
  f = len > 1e-4 ? [f[0] / len, f[1] / len, f[2] / len] : [0, 0, 1];

  const at = (arr: number[] | undefined, scale: number): number | null =>
    arr?.length === ghost.path.length ? lerp(arr[i], arr[j], k) / scale : null;
  // Orientation: normalised lerp of the two samples' quaternions, the short way round.
  let quat: PlaybackSample["quat"] = null;
  if (ghost.rot?.length === ghost.path.length * 4) {
    const qa = ghost.rot.slice(4 * i, 4 * i + 4), qb = ghost.rot.slice(4 * j, 4 * j + 4);
    const sign = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
    const q = qa.map((v, c) => lerp(v, sign * qb[c], k));
    const norm = Math.hypot(q[0], q[1], q[2], q[3]);
    if (norm > 1e-6) quat = [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
  }
  const four = (arr: number[] | undefined, scale: number, wrap = 0): [number, number, number, number] | null => {
    if (arr?.length !== ghost.path.length * 4) return null;
    const one = (c: number) => {
      let b = arr[4 * j + c];
      // A wheel's angle wraps every 256 turns: a sample pair across the seam must not spin it back.
      if (wrap && Math.abs(b - arr[4 * i + c]) > wrap / 2) b += b < arr[4 * i + c] ? wrap : -wrap;
      return lerp(arr[4 * i + c], b, k) / scale;
    };
    return [one(0), one(1), one(2), one(3)];
  };
  const timed = ghost.times?.length === ghost.path.length;
  const raceTime = timed ? lerp(ghost.times![i], ghost.times![j], k) : clamped;
  return {
    pos, forward: f, quat,
    steer: at(ghost.steer, 100), gas: at(ghost.gas, 100), brake: at(ghost.brake, 100), speed: at(ghost.speed, 1),
    wheelRot: four(ghost.wheelRot, 1000, WHEEL_WRAP), damper: four(ghost.damper, 1000),
    raceTime,
    checkpointsTaken: timeline.checkpoints.filter((c) => c <= clamped).length,
    entry: e,
  };
}

/** Playback time one sample further (or back), for the step buttons. */
export function stepTime(timeline: PlaybackTimeline, ms: number, samples: number): number {
  if (!timeline.t.length) return 0;
  const e = entryAt(timeline, ms);
  // Between two samples, a step back lands on the one just passed, not the one before it.
  const target = samples < 0 && timeline.t[e] < ms ? e + samples + 1 : e + samples;
  return timeline.t[Math.min(Math.max(target, 0), timeline.t.length - 1)];
}
