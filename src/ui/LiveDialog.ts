import type { EditorContext } from "@plugins/api";
import { getLiveSession, liveRequest } from "@plugins/liveSession";
import { el } from "./dom";
import { openDialog } from "./dialog";
import { persistNow, session } from "./session";
import { saveMap } from "@io/mapStore";

export function openLiveDialog(ctx: EditorContext): void {
  const live = getLiveSession(ctx);
  const status = el("p", { class: "dialog-message", role: "status" }, "Checking game bridge…");
  const result = el("p", { class: "dialog-message", role: "status" });
  const install = el("button", { class: "btn" }, "Install / pair game plugin");
  const connect = el("button", { class: "btn primary" }, "Connect and load game map");
  const disconnect = el("button", { class: "btn" }, "Disconnect auto sync");
  let token = "";
  let busy = false;
  let ready = false;
  let protocol = 0;
  const buttons = () => {
    install.disabled = busy || live.connected || live.working || !token;
    connect.disabled = busy || live.connected || live.working || !ready || protocol !== 2;
    disconnect.disabled = !live.connected && !live.working;
  };
  const refresh = async () => {
    try {
      const data = await liveRequest("status");
      token = data.token; ready = data.online && data.game?.ready; protocol = data.game?.protocol;
      status.textContent = live.connected || live.working ? live.message
        : !data.online ? "Game bridge offline. Install the plugin, then load Trackedit Live in Openplanet."
        : protocol !== 2 ? "Install / pair and reload Trackedit Live to enable automatic sync."
        : data.game?.error || "Game editor ready. Connect to load its map and start syncing.";
    } catch (err) { token = ""; ready = false; status.textContent = (err as Error).message; }
    if (!live.connected && live.message !== "Not connected") result.textContent = live.message;
    buttons();
  };
  install.onclick = async () => {
    busy = true; buttons();
    try {
      const data = await liveRequest("install", token, {});
      result.textContent = data.message;
    } catch (err) { result.textContent = (err as Error).message; }
    finally { busy = false; await refresh(); }
  };
  connect.onclick = async () => {
    busy = true; result.textContent = "Loading game map…"; buttons();
    try {
      // Keep the current browser document saved before loading a separate live map.
      if (session.ready || ctx.document.layers.some(layer => layer.placements.size > 0)) {
        await saveMap(ctx.document, ctx.view.rig.getState());
      }
      await live.connect();
      if (live.connected) { session.ready = true; await persistNow(ctx); result.textContent = "Connected. Close this dialog and edit in either editor."; }
    } catch (err) { result.textContent = (err as Error).message; }
    finally { busy = false; await refresh(); }
  };
  disconnect.onclick = () => { live.disconnect(); void refresh(); };
  const content = el("div", { class: "settings-dialog" },
    el("p", { class: "dialog-message" }, "Connect to load the map currently open in Trackmania. Your current browser map is saved first. Block edits then sync automatically in both directions, even with this dialog closed."),
    install, status, connect, disconnect,
    el("p", { class: "dialog-message" }, "Syncs grid, ghost and free blocks, transforms, variants and colors. Items are shown read-only. Skins, terrain, and map settings are not editable through this connection."),
    result,
  );
  content.addEventListener("keydown", e => e.stopPropagation());
  openDialog({ title: "Live editor", content, width: 460 });
  buttons();
  const poll = async () => {
    if (!content.isConnected) return;
    await refresh();
    if (content.isConnected) window.setTimeout(() => void poll(), 1000);
  };
  void poll();
}
