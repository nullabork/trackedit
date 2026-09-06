import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapDocument } from "@core/document";
import { History, AddPlacementCmd, RemovePlacementCmd } from "@core/commands";
import { SelectionModel } from "@core/selection";
import { normalizeBlock, mergeBlockDelta, type LiveSnapshot } from "@core/liveSync";
import { LiveSession, projectLiveDocument } from "./liveSession";
import type { EditorContext } from "./api";

const block = (x: number) => normalizeBlock({ name: "RoadTechStraight", coord: [x, 8, 2] });
let snapshot: LiveSnapshot;
let requests: Array<Record<string, any>>;
let live: LiveSession;
let ctx: EditorContext;
let delayed: (() => void) | undefined;
let delayCommand: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  snapshot = { mapSession: "game-map", revision: 1, mapName: "Game track", decoration: "48x48Screen155Day", size: [48, 40, 48], yOffset: 8, blocks: [block(1)], items: [] };
  requests = []; delayCommand = false; delayed = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/status")) return response({ token: "token" });
    if (url.endsWith("/connect")) return response({ ok: true, mapSession: snapshot.mapSession });
    if (url.includes("/snapshot?")) return response({ game: { ready: true, mapSession: snapshot.mapSession }, snapshot });
    if (url.endsWith("/command")) {
      requests.push(body);
      snapshot = { ...snapshot, revision: snapshot.revision + 1, blocks: mergeBlockDelta(snapshot.blocks, body.payload) };
      if (delayCommand) await new Promise<void>(resolve => { delayed = resolve; });
      return response({ ok: true, snapshot });
    }
    return response({ ok: true });
  }));
  const document = new MapDocument();
  ctx = { document, history: new History(document), selection: new SelectionModel(), tools: { setBuildLevel: vi.fn() }, ui: { setStatus: vi.fn() } } as unknown as EditorContext;
  live = new LiveSession(ctx);
});
afterEach(() => { live.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const add = (x: number, name = "RoadTechStraight") => ctx.history.run(new AddPlacementCmd(ctx.document.activeLayer.id, { id: `local-${x}`, kind: "block", block: name, coord: [x, 8, 2], dir: 0 }));
const xs = () => projectLiveDocument(ctx.document, 8).blocks.map(r => r.block.coord[0]).sort();

describe("live editor session", () => {
  it("loads the current game map on connect and sends nothing for the import", async () => {
    add(20);
    await live.connect();
    expect(ctx.document.name).toBe("Game track");
    expect(xs()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(600);
    expect(requests).toEqual([]);
  });

  it("syncs local additions and undo without an echo loop", async () => {
    await live.connect(); add(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(snapshot.blocks.map(b => b.coord[0])).toEqual([1, 2]);
    ctx.history.undo();
    await vi.advanceTimersByTimeAsync(600);
    expect(snapshot.blocks.map(b => b.coord[0])).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(2);
  });

  it("merges a remote addition with a pending browser addition", async () => {
    await live.connect(); add(2);
    snapshot = { ...snapshot, revision: 2, blocks: [...snapshot.blocks, block(3)] };
    await vi.advanceTimersByTimeAsync(600);
    expect(xs()).toEqual([1, 2, 3]);
    expect(snapshot.blocks).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(600);
    expect(requests).toHaveLength(1);
  });

  it("continues sending new blocks after PlatformBase resolves variant 0 to 2", async () => {
    await live.connect();
    add(2, "PlatformBase"); delayCommand = true;
    await vi.advanceTimersByTimeAsync(501);
    expect(requests[0].payload.add[0].autoVariant).toBe(true);
    snapshot.blocks.find(b => b.coord[0] === 2)!.mobilVariant = 0;
    snapshot.blocks.find(b => b.coord[0] === 2)!.variant = 2;
    snapshot.blocks.find(b => b.coord[0] === 2)!.autoVariant = false;
    delayCommand = false; delayed!();
    await vi.advanceTimersByTimeAsync(600);
    expect(live.connected).toBe(true);
    expect(requests).toHaveLength(1);
    add(3, "PlatformBase");
    await vi.advanceTimersByTimeAsync(600);
    expect(requests).toHaveLength(2);
    expect(xs()).toEqual([1, 2, 3]);
    expect(snapshot.blocks.map(b => b.coord[0])).toEqual([1, 2, 3]);
    expect(projectLiveDocument(ctx.document, 8).blocks.find(r => r.block.coord[0] === 2)!.block).toMatchObject({ variant: 2, autoVariant: false });
  });

  it("applies game deletions without sending them back and preserves unchanged IDs", async () => {
    snapshot.blocks.push(block(2));
    await live.connect();
    const first = projectLiveDocument(ctx.document, 8).blocks.find(r => r.block.coord[0] === 1)!;
    snapshot = { ...snapshot, revision: 2, blocks: [block(1)] };
    await vi.advanceTimersByTimeAsync(600);
    expect(xs()).toEqual([1]);
    expect(projectLiveDocument(ctx.document, 8).blocks[0].placementId).toBe(first.placementId);
    expect(requests).toHaveLength(0);
  });

  it("keeps edits made while a game command is in flight", async () => {
    await live.connect(); add(2); delayCommand = true;
    await vi.advanceTimersByTimeAsync(501);
    expect(delayed).toBeDefined();
    add(3); delayCommand = false; delayed!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(xs()).toEqual([1, 2, 3]);
    expect(snapshot.blocks.map(b => b.coord[0]).sort()).toEqual([1, 2, 3]);
  });

  it("pauses a conflicting deletion and retains browser changes", async () => {
    await live.connect();
    const row = projectLiveDocument(ctx.document, 8).blocks[0];
    ctx.history.run(new RemovePlacementCmd(row.layerId, row.placementId)); add(4);
    snapshot = { ...snapshot, revision: 2, blocks: [block(3)] };
    await vi.advanceTimersByTimeAsync(600);
    expect(live.connected).toBe(false);
    expect(live.message).toContain("both editors");
    expect(xs()).toEqual([4]);
    expect(requests).toHaveLength(0);
  });

  it("stops instead of sending old edits into another game map", async () => {
    await live.connect(); add(2);
    snapshot = { ...snapshot, mapSession: "another-map" };
    await vi.advanceTimersByTimeAsync(600);
    expect(live.connected).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("keeps layer visibility local and bakes layer transforms into free blocks", async () => {
    await live.connect();
    const layer = ctx.document.activeLayer;
    layer.visible = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(requests).toHaveLength(0);
    layer.transform.translate = [32, 0, 0];
    await vi.advanceTimersByTimeAsync(600);
    expect(requests[0].payload.add[0].isFree).toBe(true);
    expect(snapshot.blocks[0].absPos[0]).toBe(64);
  });
});
