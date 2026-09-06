import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveQueue, validateCommand } from "./liveBridge";
import { normalizeBlock, type LiveSnapshot } from "../src/core/liveSync";

const status = { instance: "game-1", mapSession: "map-1", inEditor: true, ready: true };
const block = { name: "RoadTechStraight", coord: [2, 8, 3], dir: 1, isGround: false };
afterEach(() => vi.useRealTimers());

describe("live command delivery", () => {
  it("verifies replacement readback before acknowledging a sync command", async () => {
    const old = normalizeBlock({ name: "PlatformBase", coord: [5, 18, 42], variant: 2, mobilVariant: 0 });
    const fresh = normalizeBlock({ name: "PlatformBase", coord: [5, 18, 42] });
    for (const actual of [[old], []]) {
      const queue = new LiveQueue();
      queue.poll(status);
      queue.snapshot = { mapSession: status.mapSession, revision: 56, blocks: [old], items: [], mapName: "Test", decoration: "Day", size: [48, 40, 48], yOffset: 8 } satisfies LiveSnapshot;
      const response = queue.submit("sync", { revision: 56, remove: [old], add: [fresh] });
      const command = queue.poll(status)!;
      queue.complete(command.id, { ok: true, snapshot: { ...queue.snapshot, blocks: actual } });
      expect((await response).ok).toBe(actual.length === 1);
    }
  });
  it("delivers a placement only once, ignores unrelated results, and accepts its result", async () => {
    const queue = new LiveQueue();
    queue.poll(status);
    const result = queue.submit("place", block);
    const command = queue.poll(status)!;
    expect(command.payload).toEqual(block);
    expect(command.mapSession).toBe(status.mapSession);
    expect(queue.poll(status)).toBeNull();
    expect(() => queue.submit("place", block)).toThrow("still running");
    queue.complete("wrong-id", { ok: true });
    expect(queue.pending).toBeDefined();
    queue.complete(command.id, { ok: true });
    expect(await result).toEqual({ ok: true });
    expect(queue.poll(status)).toBeNull();
  });

  it("expires an undelivered command so reconnect cannot place it later", async () => {
    vi.useFakeTimers();
    const queue = new LiveQueue(100);
    queue.poll(status);
    const result = queue.submit("place", block);
    vi.advanceTimersByTime(101);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
    expect(queue.poll(status)).toBeNull();
  });

  it("reports an uncertain result without replaying a delivered command", async () => {
    vi.useFakeTimers();
    const queue = new LiveQueue(100);
    queue.poll(status);
    const result = queue.submit("place", block);
    queue.poll(status);
    vi.advanceTimersByTime(101);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining("may have run") });
    expect(queue.poll(status)).toBeNull();
  });

  it("cancels a queued command when the game plugin restarts", async () => {
    const queue = new LiveQueue();
    queue.poll(status);
    const result = queue.submit("place", block);
    expect(queue.poll({ ...status, instance: "game-2" })).toBeNull();
    expect(await result).toMatchObject({ ok: false });
  });

  it("requires a ready editor and rejects room commands", () => {
    const queue = new LiveQueue();
    expect(() => queue.submit("place", block)).toThrow("offline");
    queue.poll({ ...status, ready: false, inEditor: false });
    expect(() => queue.submit("place", block)).toThrow("ready");
    expect(() => validateCommand("join", { roomId: "ABCDEF" })).toThrow("Unknown");
  });

  it("cancels pending placements when the map changes or testing starts", async () => {
    for (const next of [{ ...status, mapSession: "map-2" }, { ...status, ready: false }]) {
      const queue = new LiveQueue();
      queue.poll(status);
      const result = queue.submit("place", block);
      expect(queue.poll(next)).toBeNull();
      expect(await result).toMatchObject({ ok: false });
    }
  });

  it("rejects stale heartbeats and malformed block coordinates", () => {
    vi.useFakeTimers();
    const queue = new LiveQueue();
    queue.poll(status);
    vi.advanceTimersByTime(5001);
    expect(() => queue.submit("place", block)).toThrow("offline");
    expect(() => validateCommand("place", block)).not.toThrow();
    for (const coord of [[1.5, 8, 1], [-1, 8, 1], [1, 256, 1], [1, 8]]) {
      expect(() => validateCommand("place", { ...block, coord })).toThrow("coordinates");
    }
    expect(() => validateCommand("erase", block)).toThrow("Unknown");
  });
});
