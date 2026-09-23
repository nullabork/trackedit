/**
 * Tracking a club room ("server"): what to do with each answer from Nadeo.
 * Pure — the polling, the map loading and the UI live in plugins/roomTracker.ts.
 */

/** A club room as the bridge lists it (tools/nadeoBridge.ts). */
export interface RoomRef {
  clubId: number;
  activityId: number;
  name: string;
  clubName: string;
}

export interface Room extends RoomRef {
  playerCount: number;
  maxPlayers: number;
  /** false: a player's own dedicated server — Nadeo does not know what it is playing. */
  nadeoHosted: boolean;
  maps: string[];
}

export interface RoomState extends Room {
  running: boolean;
  currentMapUid: string | null;
  at: number;
}

/**
 * Nadeo publishes no rate limit; the community guideline is ~2 requests/second for
 * short bursts and less for monitoring. One poll is one request: 4 a minute.
 */
export const POLL_MS = 15_000;
/** A room that is off has nothing to change until somebody joins: ask less often. */
export const IDLE_POLL_MS = 60_000;
/** Errors back off: 15 s, 30 s, 60 s, then every 2 min. */
export const MAX_BACKOFF_MS = 120_000;

export interface TrackDecision {
  /** The map to open now, or null. */
  load: string | null;
  /** The server's map when this run first meets it — opened now, or open already. The "when a map opens" options run on it. */
  arrived: string | null;
  /** The server's map as of this answer — what the next answer is compared with. */
  seenUid: string | null;
  nextPollMs: number;
  note: string;
}

/**
 * A map is opened when THE SERVER moves to another map — not whenever the open
 * document differs from it: open something else while tracking and it stays open
 * until the server's next map. The first answer after "Start tracking" opens the
 * server's map unless it is the one already open.
 */
export function decide(room: RoomState, seenUid: string | null, openMapUid: string | null): TrackDecision {
  const players = `${room.playerCount}/${room.maxPlayers} players`;
  // By what the answer holds, not by who hosts: a player's own server reports no map (checked),
  // but if one ever does, it is tracked like any other.
  if (!room.currentMapUid && !room.nadeoHosted) {
    return { load: null, arrived: null, seenUid, nextPollMs: IDLE_POLL_MS, note: `${room.name} runs on a player's own server: Nadeo does not say which map it is playing (${players}).` };
  }
  if (!room.running || !room.currentMapUid) {
    return { load: null, arrived: null, seenUid, nextPollMs: IDLE_POLL_MS, note: `${room.name} is off — a room's server stops when it is empty. Waiting for it to start.` };
  }
  const uid = room.currentMapUid;
  if (uid === seenUid) return { load: null, arrived: null, seenUid, nextPollMs: POLL_MS, note: `${room.name} is still on the same map (${players}).` };
  if (seenUid === null && uid === openMapUid) return { load: null, arrived: uid, seenUid: uid, nextPollMs: POLL_MS, note: `${room.name} is playing the open map (${players}).` };
  return { load: uid, arrived: uid, seenUid: uid, nextPollMs: POLL_MS, note: `${room.name} ${seenUid === null ? "is playing" : "moved to"} another map (${players}).` };
}

/** What to do once a tracked server's map is open. All off by default. */
export interface ArrivalOptions {
  /** Load the fastest line there is: TMX's fastest replay, else Nadeo's world record. */
  loadFastest: boolean;
  /** Select that line and watch it from the driver's seat. */
  firstPerson: boolean;
  /** Play it. */
  drive: boolean;
  /** Start it over when it ends. */
  repeat: boolean;
}

export const DEFAULT_ARRIVAL: ArrivalOptions = { loadFastest: false, firstPerson: false, drive: false, repeat: false };

/** The wait after the n-th failure in a row (n >= 1). */
export const backoffMs = (failures: number): number =>
  Math.min(POLL_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
