import type { EditorContext } from "@plugins/api";
import { clear, el } from "./dom";
import { cloneFlow, exportJsonFlow, importJsonFlow, newMapGuarded } from "./mapActions";
import { openMapBrowser } from "./MapBrowserDialog";
import { openTmxDialog } from "./TmxDialog";
import { openLiveDialog } from "./LiveDialog";
import { getLiveSession } from "@plugins/liveSession";
import { openControlSettings } from "./ControlSettingsDialog";

interface MenuEntry {
  label: string;
  action?: () => void;
  divider?: boolean;
}

/** Slim top menu bar (style guide §5.6): File ▾ with the map lifecycle. */
export function buildMenuBar(ctx: EditorContext, host: HTMLElement): void {
  const fileEntries: MenuEntry[] = [
    { label: "New…", action: () => void newMapGuarded(ctx) },
    { label: "Open…", action: () => openMapBrowser(ctx) },
    { label: "Open from TMX…", action: () => openTmxDialog(ctx) },
    { label: "", divider: true },
    { label: "Import JSON…", action: () => importJsonFlow(ctx) },
    { label: "Export JSON", action: () => exportJsonFlow(ctx) },
    { label: "", divider: true },
    { label: "Clone track", action: () => void cloneFlow(ctx) },
  ];

  let openPop: HTMLElement | null = null;
  const closePop = () => {
    openPop?.remove();
    openPop = null;
  };

  const menuButton = (label: string, entries: MenuEntry[]) => {
    const btn = el("button", { class: "menu-btn" }, label);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openPop) {
        closePop();
        return;
      }
      const pop = el("div", { class: "menu-pop" });
      for (const entry of entries) {
        if (entry.divider) {
          pop.append(el("div", { class: "menu-div" }));
          continue;
        }
        const item = el("div", { class: "menu-item" }, entry.label);
        item.addEventListener("click", () => {
          closePop();
          entry.action?.();
        });
        pop.append(item);
      }
      const rect = btn.getBoundingClientRect();
      pop.style.left = `${rect.left}px`;
      pop.style.top = `${rect.bottom + 2}px`;
      document.body.append(pop);
      openPop = pop;
    });
    return btn;
  };

  window.addEventListener("pointerdown", (e) => {
    if (openPop && !openPop.contains(e.target as Node)) closePop();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePop();
  });

  const title = el("span", { class: "menu-title" });
  const refreshTitle = () => {
    clear(title);
    title.append(ctx.document.name);
  };
  ctx.document.events.on("reset", refreshTitle);
  ctx.document.events.on("mapChanged", refreshTitle);
  refreshTitle();

  const live = getLiveSession(ctx);
  const liveButton = el("button", { class: "menu-btn", onclick: () => openLiveDialog(ctx) }, "Live editor · disconnected");
  const syncStatus = el("span", { class: "live-sync-status", role: "status" });
  live.events.on("status", message => {
    liveButton.textContent = live.connected ? "Live editor · syncing" : live.working ? "Live editor · connecting" : "Live editor · disconnected";
    syncStatus.textContent = message;
    syncStatus.title = message;
  });
  host.append(
    el("span", { class: "menu-brand" }, "trackedit"),
    menuButton("File", fileEntries),
    el("button", { class: "menu-btn", onclick: () => openControlSettings(ctx) }, "Controls"),
    liveButton,
    syncStatus,
    el("span", { class: "menu-spacer" }),
    title,
  );
}
