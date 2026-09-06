import type { EditorContext } from "./api";
import { MapDocument } from "@core/document";
import { createLayer } from "@core/layer";
import { newId } from "@core/math";
import { blockDelta, blockKey, mergeBlockDelta, normalizeBlock, type LiveSnapshot, type SyncBlock } from "@core/liveSync";
import { importDump, exportDump } from "@io/trackoJson";
import { AddPlacementCmd, RemovePlacementCmd } from "@core/commands";
import { Emitter } from "@core/events";

export async function liveRequest(path: string, token = "", body?: unknown) {
  const response = await fetch(`/api/live/${path}`, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json", "X-Trackedit-Token": token }, body: JSON.stringify(body),
  });
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Live API unavailable. Restart npm run dev and reload the page.");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Live connection failed.");
  return data;
}

interface LocalBlock { block: SyncBlock; layerId: string; placementId: string }
interface Projection { blocks: LocalBlock[]; items: string }

/** Use the existing world-transform exporter, including hidden layers in live sync. */
export function projectLiveDocument(doc: MapDocument, offset: number): Projection {
  const copy = new MapDocument();
  copy.reset(doc.layers.map(layer => ({ ...layer, visible: true, placements: new Map([...layer.placements].map(([id, p]) =>
    [id, { ...p, meta: { ...p.meta, __liveLayer: layer.id, __liveId: id } }])) })), { name: doc.name, decoration: doc.decoration });
  const dump = exportDump(copy, offset);
  return {
    blocks: (dump.blocks ?? []).map(b => ({ block: normalizeBlock(b), layerId: String(b.__liveLayer), placementId: String(b.__liveId) })),
    items: JSON.stringify((dump.items ?? []).map(({ __liveId, __liveLayer, ...item }) => item)),
  };
}

export class LiveSession {
  readonly client = crypto.randomUUID();
  connected = false;
  working = false;
  readonly events = new Emitter<{ status: string }>();
  private statusMessage = "Not connected";
  get message(): string { return this.statusMessage; }
  private set message(value: string) {
    this.statusMessage = value;
    this.events.emit("status", value);
  }
  private token = "";
  private mapSession = "";
  private base: SyncBlock[] = [];
  private offset = 8;
  private itemProjection = "[]";
  private remoteItems = "[]";
  private itemLayer = "";
  private blockLayer = "";
  private applying = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;

  constructor(private ctx: EditorContext) {
    ctx.document.events.on("reset", () => {
      if (this.connected && !this.applying) this.disconnect("Sync disconnected because a different browser map was opened.");
    });
  }

  async connect(): Promise<void> {
    if (this.connected || this.working) return;
    const generation = ++this.generation;
    this.working = true;
    this.message = "Loading the game map…";
    try {
      this.token = (await liveRequest("status")).token;
      const result = await liveRequest("connect", this.token, { client: this.client });
      this.mapSession = result.mapSession;
      let snapshot: LiveSnapshot | null = null;
      for (let i = 0; i < 30 && !snapshot; i++) {
        if (generation !== this.generation) return;
        const reply = await liveRequest(`snapshot?client=${this.client}`);
        if (reply.game.mapSession !== this.mapSession) throw new Error("Game map changed while connecting. Connect again.");
        snapshot = reply.snapshot;
        if (!snapshot) await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!snapshot) throw new Error("Timed out loading the game map. Reload Trackedit Live and connect again.");
      if (generation !== this.generation) return;
      this.offset = snapshot.yOffset;
      const blocks = importDump({ blocks: snapshot.blocks }, this.offset).layers[0];
      blocks.name = "Game blocks";
      const items = importDump({ items: snapshot.items }, this.offset).layers[0];
      items.name = "Game items (read-only)"; items.locked = true;
      this.blockLayer = blocks.id; this.itemLayer = items.id;
      this.applying = true;
      try {
        this.ctx.document.id = newId("map");
        this.ctx.document.reset([blocks, items], { name: snapshot.mapName || "Live map", decoration: snapshot.decoration.replace(/^Base/, ""), size: snapshot.size });
        this.ctx.document.setActiveLayer(blocks.id);
        this.ctx.selection.clear();
        this.ctx.history.clear();
        this.ctx.tools.setBuildLevel(Math.max(1, this.offset));
      } finally { this.applying = false; }
      this.base = snapshot.blocks.map(b => normalizeBlock(b as unknown as Record<string, unknown>));
      this.remoteItems = JSON.stringify(snapshot.items);
      this.itemProjection = projectLiveDocument(this.ctx.document, this.offset).items;
      this.connected = true;
      this.message = `Syncing ${this.base.length} blocks with ${snapshot.mapName || "the game"}`;
      this.ctx.ui.setStatus(this.message);
      this.schedule();
    } catch (err) {
      this.disconnect((err as Error).message);
      throw err;
    } finally { this.working = false; }
  }

  disconnect(message = "Automatic sync disconnected. The browser map is kept."): void {
    this.generation++;
    this.connected = false;
    clearTimeout(this.timer);
    this.message = message;
    if (this.token) void liveRequest("disconnect", this.token, { client: this.client }).catch(() => {});
    this.ctx.ui.setStatus(message);
  }

  private schedule(): void { this.timer = setTimeout(() => void this.tick(), 500); }

  private local(): Projection {
    const projection = projectLiveDocument(this.ctx.document, this.offset);
    if (projection.items !== this.itemProjection) throw new Error("Items are read-only during block sync. Sync paused; browser changes are kept.");
    return projection;
  }

  private async tick(): Promise<void> {
    if (!this.connected) return;
    const generation = this.generation;
    try {
      const reply = await liveRequest(`snapshot?client=${this.client}`);
      if (generation !== this.generation) return;
      if (reply.game.mapSession !== this.mapSession) throw new Error("The game map changed. Connect again to load the new map.");
      if (!reply.snapshot) {
        this.message = reply.game.error || "Waiting for the game editor; local block changes are queued.";
        return;
      }
      let snapshot = reply.snapshot as LiveSnapshot;
      if (snapshot.yOffset !== this.offset) throw new Error("The game map's coordinate origin changed. Reconnect to reload it.");
      const current = this.local().blocks.map(r => r.block);
      const delta = blockDelta(this.base, current);
      let target = mergeBlockDelta(snapshot.blocks, delta);
      if (delta.remove.length || delta.add.length) {
        this.message = "Sending block changes…";
        const result = await liveRequest("command", this.token, { client: this.client, action: "sync", payload: {
          mapSession: this.mapSession, revision: snapshot.revision, ...delta,
        } });
        if (generation !== this.generation) return;
        if (result.conflict) return; // No game mutation occurred; rebase against the next snapshot.
        if (!result.ok) throw new Error(result.error || "Game did not confirm the edits. Reconnect to inspect it.");
        snapshot = result.snapshot;
        if (!snapshot || snapshot.mapSession !== this.mapSession) throw new Error("Missing game readback. Sync stopped.");
        // Preserve browser edits made while the request was in flight.
        const pending = blockDelta(current, this.local().blocks.map(r => r.block));
        target = mergeBlockDelta(snapshot.blocks, pending);
      }
      this.reconcile(target, snapshot);
      this.base = snapshot.blocks.map(b => normalizeBlock(b as unknown as Record<string, unknown>));
      this.message = `Syncing ${snapshot.blocks.length} blocks · ${snapshot.mapName || "game map"}`;
    } catch (err) {
      if (generation === this.generation) this.disconnect((err as Error).message);
    } finally {
      if (this.connected && generation === this.generation) this.schedule();
    }
  }

  private reconcile(target: SyncBlock[], snapshot: LiveSnapshot): void {
    const current = this.local().blocks;
    const byKey = new Map<string, LocalBlock[]>();
    for (const row of current) {
      const key = blockKey(row.block); const bucket = byKey.get(key) ?? [];
      bucket.push(row); byKey.set(key, bucket);
    }
    const add: SyncBlock[] = [];
    for (const b of target) {
      const bucket = byKey.get(blockKey(b));
      if (bucket?.length) bucket.pop(); else add.push(b);
    }
    const remove = [...byKey.values()].flat();
    const itemsChanged = JSON.stringify(snapshot.items) !== this.remoteItems;
    if (!add.length && !remove.length && !itemsChanged) return;
    this.applying = true;
    try {
      for (const row of remove) {
        new RemovePlacementCmd(row.layerId, row.placementId).execute(this.ctx.document);
        this.ctx.selection.remove(row.placementId);
      }
      let layer = this.ctx.document.getLayer(this.blockLayer);
      if (!layer || layer.transform.translate.some(n => n !== 0) || layer.transform.rotDeg.some(n => n !== 0)) {
        layer = createLayer("Game updates"); this.ctx.document.mutAddLayer(layer); this.blockLayer = layer.id;
      }
      for (const p of importDump({ blocks: add }, this.offset).layers[0].placements.values()) new AddPlacementCmd(layer.id, p).execute(this.ctx.document);
      if (itemsChanged) {
        let itemLayer = this.ctx.document.getLayer(this.itemLayer);
        if (!itemLayer) { itemLayer = createLayer("Game items (read-only)"); itemLayer.locked = true; this.ctx.document.mutAddLayer(itemLayer); this.itemLayer = itemLayer.id; }
        for (const id of [...itemLayer.placements.keys()]) new RemovePlacementCmd(itemLayer.id, id).execute(this.ctx.document);
        for (const p of importDump({ items: snapshot.items }, this.offset).layers[0].placements.values()) new AddPlacementCmd(itemLayer.id, p).execute(this.ctx.document);
        this.remoteItems = JSON.stringify(snapshot.items);
      }
      this.itemProjection = projectLiveDocument(this.ctx.document, this.offset).items;
      // A native undo must never target placements removed/recreated by another editor.
      this.ctx.history.clear();
    } finally { this.applying = false; }
  }
}

const sessions = new WeakMap<EditorContext, LiveSession>();
export function getLiveSession(ctx: EditorContext): LiveSession {
  let session = sessions.get(ctx);
  if (!session) { session = new LiveSession(ctx); sessions.set(ctx, session); }
  return session;
}
