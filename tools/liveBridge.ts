import type { Plugin } from "vite";
import { randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { validateSyncBlock, verifyBlockReadback, type BlockDelta, type LiveSnapshot } from "../src/core/liveSync";

type Payload = Record<string, unknown>;
export interface GameStatus {
  instance: string;
  inEditor: boolean;
  ready: boolean;
  mapSession: string;
  error?: string;
  protocol?: number;
}
interface Command { id: string; action: "place" | "sync"; payload: Payload; instance: string; mapSession: string }

/** One command at a time, delivered once. A lost result must never replay a placement. */
export class LiveQueue {
  status?: GameStatus;
  seen = 0;
  snapshot?: LiveSnapshot;
  lastCommand?: { action: string; payload: Payload; sentAt: number; result?: Payload };
  pending?: { command: Command; before?: LiveSnapshot; delivered: boolean; finish: (result: Payload) => void; timer: ReturnType<typeof setTimeout> };
  constructor(private timeoutMs = 45000) {}
  online(): boolean { return !!this.status && Date.now() - this.seen < 5000; }
  poll(status: GameStatus): Command | null {
    if (this.snapshot?.mapSession !== status.mapSession) this.snapshot = undefined;
    this.status = status;
    this.seen = Date.now();
    const p = this.pending;
    if (!p || p.delivered) return null;
    if (p.command.instance !== status.instance) {
      this.complete(p.command.id, { ok: false, error: "Game bridge restarted; command cancelled." });
      return null;
    }
    if (!status.ready || p.command.mapSession !== status.mapSession) {
      this.complete(p.command.id, { ok: false, error: "Game map changed or editor is no longer ready; command cancelled." });
      return null;
    }
    p.delivered = true;
    return p.command;
  }
  submit(action: Command["action"], payload: Payload): Promise<Payload> {
    if (!this.online()) throw new Error("Trackedit Live is offline. Load the plugin in Openplanet first.");
    if (this.status?.error) throw new Error(this.status.error);
    if (this.pending) throw new Error("Another game command is still running.");
    if (!this.status!.ready || !this.status!.mapSession) throw new Error("Open a map and wait for the game editor to be ready.");
    if (action === "sync" && (!this.snapshot || this.snapshot.revision !== payload.revision)) return Promise.resolve({ ok: false, conflict: true });
    const command: Command = { id: randomUUID(), action, payload, instance: this.status!.instance, mapSession: this.status!.mapSession };
    this.lastCommand = { action, payload, sentAt: Date.now() };
    return new Promise((finish) => {
      const timer = setTimeout(() => this.complete(command.id, {
        ok: false, error: this.pending?.delivered
          ? "Game result timed out. Check the game before sending again; the command may have run."
          : "Game bridge stopped polling; command cancelled.",
      }), this.timeoutMs);
      this.pending = { command, before: this.snapshot, delivered: false, finish, timer };
    });
  }
  complete(id: string, result: Payload): void {
    if (this.pending?.command.id !== id) return;
    const p = this.pending;
    if (p.command.action === "sync" && result.ok) {
      try {
        const after = result.snapshot as LiveSnapshot | undefined;
        if (!p.before || !after || after.mapSession !== p.command.mapSession || !Array.isArray(after.blocks)) throw new Error("Missing game readback. Sync stopped.");
        after.blocks.forEach(validateSyncBlock);
        verifyBlockReadback(p.before.blocks, after.blocks, p.command.payload as unknown as BlockDelta);
      } catch (err) { result = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    }
    this.pending = undefined;
    clearTimeout(p.timer);
    if (this.lastCommand) {
      const { snapshot, ...summary } = result;
      this.lastCommand.result = summary;
    }
    p.finish(result);
  }
}

export function validateCommand(action: unknown, raw: unknown): asserts action is "place" | "sync" {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Missing command payload.");
  const p = raw as Payload;
  if (action === "sync") {
    if (typeof p.mapSession !== "string" || !Number.isInteger(p.revision) || Number(p.revision) < 1) throw new Error("Invalid map revision.");
    for (const key of ["remove", "add"]) {
      const blocks = p[key];
      if (!Array.isArray(blocks) || blocks.length > 2000) throw new Error("Sync batches are limited to 2000 blocks. Split large edits into smaller steps.");
      blocks.forEach(validateSyncBlock);
    }
  } else if (action === "place") {
    if (typeof p.name !== "string" || !p.name || p.name.length > 256) throw new Error("Invalid block name.");
    if (!Array.isArray(p.coord) || p.coord.length !== 3 || !p.coord.every(n => Number.isInteger(n) && n >= 0 && n < 256)) throw new Error("Block coordinates must be grid cells from 0 to 255.");
    if (!Number.isInteger(p.dir) || Number(p.dir) < 0 || Number(p.dir) > 3 || typeof p.isGround !== "boolean") throw new Error("Invalid block direction or ground mode.");
  } else throw new Error("Unknown command.");
}

export function liveBridge(): Plugin {
  const token = randomUUID();
  const queue = new LiveQueue();
  let owner = "";
  let ownerSeen = 0;
  const checkOwner = (client: unknown) => {
    if (!owner || owner !== client) throw new Error("This browser is not connected to the live map.");
    ownerSeen = Date.now();
  };
  const acceptSnapshot = (value: unknown) => {
    const snap = value as LiveSnapshot;
    if (!snap || typeof snap.mapSession !== "string" || !Number.isInteger(snap.revision) || snap.revision < 1 ||
        !Array.isArray(snap.blocks) || snap.blocks.length > 100000 || !Array.isArray(snap.items) ||
        typeof snap.mapName !== "string" || typeof snap.decoration !== "string" ||
        !Array.isArray(snap.size) || snap.size.length !== 3 || !snap.size.every(n => Number.isInteger(n) && n > 0 && n <= 256) ||
        !Number.isFinite(snap.yOffset)) throw new Error("Invalid game snapshot. Reload Trackedit Live.");
    snap.blocks.forEach(validateSyncBlock);
    if (snap.mapSession === queue.status?.mapSession && (!queue.snapshot || snap.revision >= queue.snapshot.revision)) queue.snapshot = snap;
  };
  return {
    name: "live-editor-bridge",
    configureServer(server) {
      server.httpServer?.once("close", () => {
        if (queue.pending) queue.complete(queue.pending.command.id, { ok: false, error: "Server stopped." });
      });
      server.middlewares.use("/api/live", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        const reply = (value: unknown, code = 200) => { res.statusCode = code; res.end(JSON.stringify(value)); };
        try {
          // Keep game controls local, including when Vite is started with --host.
          const address = req.socket.remoteAddress ?? "";
          if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return reply({ error: "Local access only." }, 403);
          const host = req.headers.host ?? "";
          if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return reply({ error: "Invalid host." }, 403);
          if (req.headers.origin && new URL(req.headers.origin).host !== host) return reply({ error: "Invalid origin." }, 403);
          const url = new URL(req.url ?? "", "http://localhost");
          const path = url.pathname;
          if (req.method === "GET" && path === "/status") return reply({ token, online: queue.online(), game: queue.status, busy: !!queue.pending,
            syncing: !!owner && Date.now() - ownerSeen < 15000, lastCommand: queue.lastCommand,
            snapshot: queue.snapshot && { revision: queue.snapshot.revision, blocks: queue.snapshot.blocks.length } });
          if (req.method === "GET" && path === "/snapshot") {
            checkOwner(url.searchParams.get("client"));
            if (!queue.online()) throw new Error("Game bridge disconnected. Sync stopped; reconnect when it is available.");
            return reply({ ok: true, game: queue.status, snapshot: queue.status?.ready ? queue.snapshot : null });
          }
          if (req.method !== "POST") return reply({ error: "Not found." }, 404);
          if (req.headers["x-trackedit-token"] !== token) return reply({ error: "Pairing token does not match. Reinstall the live plugin from the editor." }, 403);
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 32 * 1024 * 1024) throw new Error("Request too large.");
          }
          const data = JSON.parse(body || "{}");
          if (path === "/poll") {
            if (typeof data.instance !== "string" || typeof data.mapSession !== "string" || typeof data.ready !== "boolean" || typeof data.inEditor !== "boolean") throw new Error("Invalid game status.");
            // Only retain fields used by the live editor bridge.
            const command = queue.poll({ instance: data.instance, mapSession: data.mapSession, ready: data.ready, inEditor: data.inEditor,
              protocol: data.protocol, error: typeof data.error === "string" ? data.error.slice(0, 1000) : undefined });
            if (data.snapshot) acceptSnapshot(data.snapshot);
            return reply({ command, watching: !!owner && Date.now() - ownerSeen < 15000 });
          }
          if (path === "/result") {
            if (typeof data.id !== "string" || typeof data.ok !== "boolean") throw new Error("Invalid result.");
            if (queue.pending?.command.id === data.id && data.snapshot) acceptSnapshot(data.snapshot);
            queue.complete(data.id, { ok: data.ok, message: data.message, error: data.error, conflict: data.conflict, snapshot: data.snapshot });
            return reply({ ok: true });
          }
          if (path === "/connect") {
            if (typeof data.client !== "string" || !data.client) throw new Error("Missing browser identity.");
            if (owner && owner !== data.client && Date.now() - ownerSeen < 15000) throw new Error("Another browser tab is syncing this game. Disconnect it first.");
            if (!queue.online() || queue.status?.protocol !== 2) throw new Error("Install / pair and reload Trackedit Live to enable automatic sync.");
            if (!queue.status.ready) throw new Error(queue.status.error || "Open a map in the game editor first.");
            owner = data.client; ownerSeen = Date.now();
            return reply({ ok: true, mapSession: queue.status.mapSession });
          }
          if (path === "/disconnect") {
            if (owner === data.client) {
              owner = "";
              if (queue.pending && !queue.pending.delivered) queue.complete(queue.pending.command.id, { ok: false, error: "Sync disconnected." });
            }
            return reply({ ok: true });
          }
          if (path === "/command") {
            validateCommand(data.action, data.payload);
            if (data.action === "sync") {
              checkOwner(data.client);
              if (data.payload.mapSession !== queue.status?.mapSession) throw new Error("The game map changed. Reconnect to load it.");
            } else if (owner && Date.now() - ownerSeen < 15000) throw new Error("Manual placement is disabled during automatic sync.");
            return reply(await queue.submit(data.action, data.payload));
          }
          if (path === "/install") {
            const cfg = JSON.parse(await readFile(join(process.cwd(), ".trackedit.local.json"), "utf8").catch(() => "{}"));
            if (!cfg.openplanetDir) throw new Error("Set your Openplanet folder in asset setup first, then install the live plugin.");
            const dest = join(cfg.openplanetDir, "Plugins", "TrackeditLive");
            await cp(join(process.cwd(), "tools", "TrackeditLive"), dest, { recursive: true });
            await writeFile(join(dest, "Config.as"), `const string BridgeUrl = ${JSON.stringify(`http://${host}/api/live`)};\nconst string BridgeToken = ${JSON.stringify(token)};\n`);
            return reply({ ok: true, message: "Installed Trackedit Live. Reload scripts or restart the game (Developer signature mode)." });
          }
          reply({ error: "Not found." }, 404);
        } catch (err) { reply({ error: err instanceof Error ? err.message : String(err) }, 400); }
      });
    },
  };
}
