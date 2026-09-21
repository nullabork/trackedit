import type { EditorContext } from "./api";
import { Emitter } from "@core/events";
import { backoffMs, decide } from "@core/roomTracking";
import type { Room, RoomRef, RoomState } from "@core/roomTracking";
import { openMapByUid } from "@ui/tmxOpen";

const STORE_KEY = "trackedit.roomTracker";

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json || json.error) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json;
}

export const searchRooms = (name: string): Promise<{ rooms: Room[]; total: number }> =>
  api(`/api/nadeo/rooms?name=${encodeURIComponent(name)}`);

export const fetchRoom = (room: RoomRef): Promise<RoomState> =>
  api(`/api/nadeo/room/${room.clubId}/${room.activityId}`);

/**
 * Follows one club room ("server"): asks the bridge what it is playing every
 * 15 s (core/roomTracking.ts has the rule and the intervals) and opens the map
 * whenever the server moves to another one. Survives the dialog and a reload:
 * the tracked room and the last map seen live in localStorage.
 */
export class RoomTracker {
  readonly events = new Emitter<{ changed: void }>();
  tracked: RoomRef | null = null;
  /** The last answer about the tracked room. */
  state: RoomState | null = null;
  note = "";
  loading = false;
  private seenUid: string | null = null;
  private timer = 0;
  private failures = 0;
  /** Bumped by start/stop: an answer that arrives for an older run is dropped. */
  private run = 0;

  constructor(private ctx: EditorContext) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as { room?: RoomRef; seenUid?: string | null } | null;
      if (saved?.room) {
        this.tracked = saved.room;
        this.seenUid = saved.seenUid ?? null;
        this.note = `Tracking ${saved.room.name}…`;
        // Let the stored track restore first: its uid decides whether there is anything to open.
        this.timer = window.setTimeout(() => void this.poll(), 3000);
      }
    } catch { /* no storage: tracking just does not survive a reload */ }
  }

  start(room: RoomRef): void {
    this.stop();
    this.tracked = { clubId: room.clubId, activityId: room.activityId, name: room.name, clubName: room.clubName };
    this.note = `Tracking ${room.name}…`;
    this.save();
    this.events.emit("changed", undefined);
    void this.poll();
  }

  stop(): void {
    this.run += 1;
    window.clearTimeout(this.timer);
    const was = this.tracked;
    this.tracked = null;
    this.state = null;
    this.seenUid = null;
    this.failures = 0;
    this.loading = false;
    this.note = was ? `Stopped tracking ${was.name}.` : "";
    this.save();
    this.events.emit("changed", undefined);
  }

  private save(): void {
    try {
      if (this.tracked) localStorage.setItem(STORE_KEY, JSON.stringify({ room: this.tracked, seenUid: this.seenUid }));
      else localStorage.removeItem(STORE_KEY);
    } catch { /* see constructor */ }
  }

  private async poll(): Promise<void> {
    const room = this.tracked;
    if (!room) return;
    const run = this.run;
    let wait: number;
    try {
      const state = await fetchRoom(room);
      if (run !== this.run) return;
      this.failures = 0;
      this.state = state;
      const d = decide(state, this.seenUid, this.ctx.document.mapUid ?? null);
      // Seen even if it then fails to open: a map the converter cannot read must not be retried every poll.
      this.seenUid = d.seenUid;
      this.save();
      this.note = d.note;
      wait = d.nextPollMs;
      if (d.load) {
        this.loading = true;
        this.events.emit("changed", undefined);
        this.ctx.ui.setStatus(`${d.note} Opening it…`);
        try {
          const summary = await openMapByUid(this.ctx, d.load);
          if (run !== this.run) return;
          this.note = `${room.name}: ${summary}`;
        } catch (err) {
          if (run !== this.run) return;
          this.note = `${room.name} moved to a map that could not be opened: ${err instanceof Error ? err.message : err}`;
          this.ctx.ui.setStatus(this.note);
        }
        this.loading = false;
      }
    } catch (err) {
      if (run !== this.run) return;
      this.failures += 1;
      wait = backoffMs(this.failures);
      this.note = `Could not ask Nadeo about ${room.name} (${err instanceof Error ? err.message : err}) — trying again in ${Math.round(wait / 1000)} s.`;
    }
    this.events.emit("changed", undefined);
    this.timer = window.setTimeout(() => void this.poll(), wait);
  }
}

const trackers = new WeakMap<EditorContext, RoomTracker>();
export function getRoomTracker(ctx: EditorContext): RoomTracker {
  let tracker = trackers.get(ctx);
  if (!tracker) { tracker = new RoomTracker(ctx); trackers.set(ctx, tracker); }
  return tracker;
}
