import { describe, expect, it } from "vitest";
import { IDLE_POLL_MS, MAX_BACKOFF_MS, POLL_MS, backoffMs, decide } from "./roomTracking";
import type { RoomState } from "./roomTracking";

const room = (over: Partial<RoomState> = {}): RoomState => ({
  clubId: 1, activityId: 2, name: "A Night Together", clubName: "Lakanta", playerCount: 15, maxPlayers: 100,
  nadeoHosted: true, maps: ["A"], running: true, currentMapUid: "A", at: 0, ...over,
});

describe("decide", () => {
  it("opens the server's map on the first answer", () => {
    expect(decide(room(), null, "other")).toMatchObject({ load: "A", seenUid: "A", nextPollMs: POLL_MS });
  });

  it("does not reopen the map that is already open", () => {
    expect(decide(room(), null, "A")).toMatchObject({ load: null, seenUid: "A" });
  });

  it("opens the next map when the server moves on", () => {
    expect(decide(room({ currentMapUid: "B" }), "A", "A")).toMatchObject({ load: "B", seenUid: "B" });
  });

  it("leaves a map the user opened meanwhile alone until the server moves", () => {
    expect(decide(room(), "A", "mine")).toMatchObject({ load: null, seenUid: "A" });
    expect(decide(room({ currentMapUid: "B" }), "A", "mine")).toMatchObject({ load: "B" });
  });

  it("waits, more slowly, while the room is off — and remembers the last map", () => {
    const d = decide(room({ running: false, currentMapUid: null }), "A", "A");
    expect(d).toMatchObject({ load: null, seenUid: "A", nextPollMs: IDLE_POLL_MS });
    // The room comes back on the same map: nothing to load.
    expect(decide(room(), d.seenUid, "A").load).toBeNull();
  });

  it("says so when the server is a player's own: Nadeo cannot tell its map", () => {
    const d = decide(room({ nadeoHosted: false, running: false, currentMapUid: null }), null, null);
    expect(d.load).toBeNull();
    expect(d.note).toMatch(/own server/);
  });
});

describe("backoffMs", () => {
  it("doubles from the poll interval up to the cap", () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([POLL_MS, POLL_MS * 2, POLL_MS * 4, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  });
});
