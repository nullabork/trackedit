import { captureDebugSubject, frameDebugSubject, inspectDebugSubject, type DebugViewOptions } from "@render/debugView";
import { Vector3 } from "three";
import type { EditorContext, EditorPlugin } from "./api";
import type { Layer, Placement } from "@core/layer";
import { getCurrentId } from "@io/mapStore";
import { el, clear } from "@ui/dom";

/**
 * Editor introspection, two ways out:
 *
 * 1. Status bar: the selected placement's block name + uid with a copy
 *    button, so a specific block can be referenced unambiguously (uids are
 *    the persistent placement ids — stable across saves).
 * 2. Dev bridge: every state change POSTs a snapshot to /api/debug/state;
 *    `GET /api/debug/state` then answers "what's selected, which layer,
 *    which map, what mode" for external tooling (or an AI assistant).
 */

interface PlacementSnapshot {
  uid: string;
  layerId: string;
  layerName: string;
  block: string;
  kind: Placement["kind"];
  worldPos?: [number, number, number];
  coord?: readonly number[];
  dir?: number;
  pos?: readonly number[];
  rot?: readonly number[];
  isItem?: boolean;
}

function layerSnapshot(l: Layer, activeId: string): Record<string, unknown> {
  return {
    id: l.id,
    name: l.name,
    active: l.id === activeId,
    visible: l.visible,
    locked: l.locked,
    clampToBase: l.clampToBase,
    gridStep: l.settings.gridStep,
    lodDistance: l.settings.lodDistance,
    transform: l.transform,
    placements: l.placements.size,
  };
}

export const instrumentationPlugin: EditorPlugin = {
  id: "builtin.instrumentation",
  name: "State instrumentation",
  init(ctx: EditorContext): void {
    const client = crypto.randomUUID();
    let placeMode: "grid" | "free" = "grid";
    ctx.events.on("placeModeChanged", ({ mode }) => (placeMode = mode));

    const placementSnapshot = (layerId: string, p: Placement): PlacementSnapshot => {
      const layer = ctx.document.getLayer(layerId);
      const obj = ctx.renderer.getObject(p.id);
      const world = obj?.getWorldPosition(new Vector3());
      return {
        uid: p.id,
        layerId,
        layerName: layer?.name ?? "?",
        block: p.block,
        kind: p.kind,
        worldPos: world
          ? [+world.x.toFixed(2), +world.y.toFixed(2), +world.z.toFixed(2)]
          : undefined,
        ...(p.kind === "block"
          ? { coord: p.coord, dir: p.dir }
          : { pos: p.pos, rot: p.rot, isItem: p.isItem }),
      };
    };

    const snapshot = (): Record<string, unknown> => {
      const doc = ctx.document;
      const active = doc.activeLayer;
      const cam = ctx.view.camera.position;
      return {
        client,
        at: new Date().toISOString(),
        map: {
          id: getCurrentId(),
          name: doc.name,
          decoration: doc.decoration,
          size: doc.size,
          globalClampToBase: doc.globalClampToBase,
        },
        mode: {
          tool: ctx.tools.activeTool?.id ?? null,
          placeMode,
          buildLevel: ctx.tools.buildLevel,
        },
        activeLayer: layerSnapshot(active, active.id),
        layers: doc.layers.map((l) => layerSnapshot(l, active.id)),
        selection: ctx.selection.list.map((e) => {
          const p = doc.getLayer(e.layerId)?.placements.get(e.placementId);
          return p
            ? placementSnapshot(e.layerId, p)
            : { uid: e.placementId, layerId: e.layerId, stale: true };
        }),
        camera: [+cam.x.toFixed(1), +cam.y.toFixed(1), +cam.z.toFixed(1)],
      };
    };

    // --- dev-bridge streaming (fire-and-forget, debounced) ---
    let timer: number | undefined;
    const push = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        void fetch("/api/debug/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(snapshot()),
        }).catch(() => {});
      }, 300);
    };
    ctx.selection.events.on("changed", push);
    ctx.tools.events.on("activeChanged", push);
    ctx.tools.events.on("buildLevelChanged", push);
    ctx.events.on("placeModeChanged", push);
    const doc = ctx.document.events;
    for (const evt of [
      "mapChanged",
      "activeLayerChanged",
      "layerAdded",
      "layerRemoved",
      "layerChanged",
      "placementAdded",
      "placementRemoved",
      "reset",
    ] as const)
      doc.on(evt, push);
    push();

    // --- screenshots over the vite dev websocket ---
    // GET /api/debug/screenshot[?target=view|selection][&uid=p-…] on the dev
    // server round-trips through here: frame the subject, render, reply PNG.
    if (import.meta.hot) {
      const hot = import.meta.hot;
      hot.on("trackedit:capture", (msg: DebugViewOptions & { id: string; target?: string }) => {
        if (msg.client && msg.client !== client) return;
        let dataUrl = "";
        try {
          dataUrl = captureDebugSubject(ctx, msg.target ?? "selection", msg);
        } catch {
          /* reply empty; server reports the failure */
        }
        hot.send("trackedit:capture-result", { id: msg.id, dataUrl });
      });
      // Generic command channel: GET /api/debug/command?action=…&uid=… on
      // the dev server lands here; the reply travels back over the ws.
      hot.on("trackedit:command", (msg: DebugViewOptions & { id: string; action: string }) => {
        if (msg.client && msg.client !== client) return;
        let result: Record<string, unknown>;
        try {
          result = runCommand(msg.action, msg.uid, msg);
        } catch (err) {
          result = { ok: false, error: String(err) };
        }
        hot.send("trackedit:command-result", { id: msg.id, ...result });
      });
    }

    const runCommand = (action: string, uid?: string, options: DebugViewOptions = {}): Record<string, unknown> => {
      if (action === "inspect") return { ok: true, ...inspectDebugSubject(ctx, options) };
      if (action === "focus") {
        frameDebugSubject(ctx, options);
        push();
        return { ok: true, ...inspectDebugSubject(ctx, options) };
      }
      if (action === "select") {
        if (!uid) {
          ctx.selection.clear();
          return { ok: true, selected: [] };
        }
        for (const layer of ctx.document.layers) {
          if (layer.placements.has(uid)) {
            ctx.selection.set([{ layerId: layer.id, placementId: uid }]);
            return { ok: true, selected: [uid], layer: layer.name };
          }
        }
        return { ok: false, error: `no placement ${uid}` };
      }
      if (action === "wireframe") {
        const renderer = ctx.renderer as { setWireframe?: (on: boolean) => void };
        renderer.setWireframe?.(uid !== "off");
        return { ok: true, wireframe: uid !== "off" };
      }
      if (action === "mood") {
        // uid doubles as the value slot: ?action=mood&uid=Night
        if (uid !== "Day" && uid !== "Night" && uid !== "Sunrise" && uid !== "Sunset")
          return { ok: false, error: `bad mood ${uid ?? "(none)"}` };
        ctx.document.setMood(uid);
        return { ok: true, mood: uid };
      }
      if (action === "render") {
        // uid: "sky:image" | "sky:color[:#rrggbb]" | "light:mood" | "light:flat"
        // (live-only test hook; the dialog is what persists prefs)
        const [what, value, extra] = (uid ?? "").split(":");
        const prefs = ctx.view.getRenderPrefs();
        if (!uid) return { ok: true, prefs }; // no arg = read current
        if (what === "sky" && (value === "image" || value === "color")) {
          prefs.sky = value;
          if (extra) prefs.skyColor = extra;
        } else if (what === "light" && (value === "mood" || value === "flat")) {
          prefs.lighting = value;
        } else {
          return { ok: false, error: `bad render arg ${uid ?? "(none)"}` };
        }
        ctx.view.setRenderPrefs(prefs);
        return { ok: true, prefs: { ...prefs } };
      }
      return { ok: false, error: `unknown action ${action}` };
    };

    // --- status bar selection readout ---
    const host = ctx.ui.statusInfo;
    if (!host) return;
    const render = () => {
      clear(host);
      const entries = ctx.selection.list;
      const isolating = ctx.renderer.isIsolating;
      const isolate = el("button", {
        class: "uid-copy", title: isolating ? "Exit isolation" : "Show only selected blocks",
        "aria-pressed": String(isolating),
      }, isolating ? "Show all" : "Isolate");
      isolate.addEventListener("click", () => {
        ctx.renderer.setIsolation(isolating ? null : entries.map(e => e.placementId));
        render();
      });
      if (entries.length === 0) {
        if (isolating) host.append(isolate);
        return;
      }
      const first = ctx.document
        .getLayer(entries[0].layerId)
        ?.placements.get(entries[0].placementId);
      const label = first
        ? (ctx.catalog.get(first.block)?.label ?? first.block)
        : entries[0].placementId;
      const uid = entries[0].placementId;
      const copy = el("button", { class: "uid-copy", title: "Copy placement uid" }, "⧉");
      copy.addEventListener("click", () => {
        void navigator.clipboard
          .writeText(uid)
          .then(() => ctx.ui.setStatus(`Copied ${uid}`))
          .catch(() => ctx.ui.setStatus("Clipboard unavailable"));
      });
      const focus = el("button", { class: "uid-copy", title: "Frame selected blocks" }, "Frame");
      focus.addEventListener("click", () => {
        try { frameDebugSubject(ctx, {}); push(); }
        catch (err) { ctx.ui.setStatus(String(err)); }
      });
      host.append(
        el("span", { class: "sel-label" }, entries.length > 1 ? `${label} +${entries.length - 1}` : label),
        el("span", { class: "sel-uid" }, uid),
        copy,
        focus,
        isolate,
      );
    };
    ctx.selection.events.on("changed", render);
    ctx.document.events.on("placementRemoved", render);
    ctx.document.events.on("reset", render);
  },
};
