import type { Vec3 } from "./math";

/**
 * A recorded run cut into what got the driver somewhere and what did not.
 *
 * A ghost records everything, including every failed try: on an RPG map
 * someone may take a jump a hundred times, respawning at the checkpoint before
 * it each time. A respawn teleports the car, so the path breaks there into
 * continuous pieces. Of each piece that ENDS in a respawn, only the part up to
 * the last checkpoint taken in it led anywhere — the rest (or all of it, if it
 * took none) is an attempt that was thrown away. The final piece reaches the
 * finish (or is where the recording stops) and counts in full.
 *
 * Needs the ghost's sample times and checkpoint times; without them nothing
 * can be told apart and every piece counts as the line, as before.
 */
export interface GhostRun {
  points: Vec3[];
  /** Index of the first point in the ghost's path (for colouring along the whole run). */
  start: number;
}

export interface GhostRuns {
  /** The driving line: the pieces that reached the next checkpoint or the finish. */
  line: GhostRun[];
  /** Tries that ended in a respawn before reaching a new checkpoint. */
  attempts: GhostRun[];
}

/** A jump longer than this (metres) between two samples is a respawn. */
export const RESPAWN_GAP = 40;

export function splitGhostRuns(
  path: readonly Vec3[],
  times?: readonly number[],
  checkpoints?: readonly number[],
  respawnGap = RESPAWN_GAP,
): GhostRuns {
  const line: GhostRun[] = [], attempts: GhostRun[] = [];
  if (path.length < 2) return { line, attempts };

  // Continuous pieces as [from, to) index ranges.
  const pieces: [number, number][] = [];
  let from = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > respawnGap) {
      pieces.push([from, i]);
      from = i;
    }
  }
  pieces.push([from, path.length]);

  const timed = !!times && times.length === path.length && !!checkpoints?.length;
  const push = (into: GhostRun[], a: number, b: number) => {
    if (b - a >= 2) into.push({ points: path.slice(a, b) as Vec3[], start: a });
  };

  pieces.forEach(([a, b], n) => {
    const last = n === pieces.length - 1;
    if (last || !timed) return push(line, a, b);
    // The last checkpoint taken within this piece, if any.
    const t0 = times![a], t1 = times![b - 1];
    let cp = -1;
    for (const c of checkpoints!) if (c >= t0 && c <= t1) cp = Math.max(cp, c);
    if (cp < 0) return push(attempts, a, b);
    // Cut at the first sample at or after the checkpoint; both halves share it, so the tubes meet.
    let cut = a;
    while (cut < b - 1 && times![cut] < cp) cut++;
    push(line, a, cut + 1);
    push(attempts, cut, b);
  });
  return { line, attempts };
}
