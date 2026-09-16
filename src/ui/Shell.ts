import type { PanelDef, UiHost } from "@plugins/api";
import { clear, el } from "./dom";

interface DrawerPage {
  id: string;
  label: string;
  element: HTMLElement;
  tab: HTMLElement;
  icon: HTMLElement;
  enabled: boolean;
}

/**
 * The fixed page layout (docs/STYLE-GUIDE.md): vertical tool rail on the
 * left, a sliding block drawer next to it, viewport in the middle, dockable
 * right column, status bar at the bottom. Panels register through the plugin
 * API's UiHost: side "left" panels live inside the drawer, side "right" in
 * the dock.
 */
export class Shell implements UiHost {
  readonly canvas: HTMLCanvasElement;
  /** Top menu bar — populated by buildMenuBar. */
  readonly menubar: HTMLElement;
  /** Vertical tool rail — populated by buildToolRail. */
  readonly rail: HTMLElement;
  /** Right end of the status bar (undo/redo etc.). */
  readonly statusActions: HTMLElement;
  /** Middle of the status bar — selection readout (block name, uid, copy). */
  readonly statusInfo: HTMLElement;
  /** Top-right viewport overlay (mood switcher etc.). */
  readonly viewportCorner: HTMLElement;
  private drawer: HTMLElement;
  private drawerTabs: HTMLElement;
  private pages: DrawerPage[] = [];
  private activePage = "bits";
  private right: HTMLElement;
  private statusText: HTMLElement;
  private hud: HTMLElement;
  private panels: PanelDef[] = [];
  private drawerOpen = false;
  private drawerWidth = 260;

  constructor(root: HTMLElement) {
    this.canvas = el("canvas", { id: "viewport" });
    this.menubar = el("div", { class: "menubar" });
    this.rail = el("div", { class: "rail" });
    this.drawer = el("div", { class: "drawer" });
    this.right = el("div", { class: "dock dock-right" });
    this.statusText = el("span", { class: "status-text" }, "Ready");
    this.statusInfo = el("span", { class: "status-info" });
    this.statusActions = el("span", { class: "status-actions" });
    this.hud = el("div", { class: "hud" });
    this.hud.style.display = "none";
    this.viewportCorner = el("div", { class: "viewport-corner" });

    // Permanent tabs on the drawer's seam, one per drawer page: each shows
    // its page's name and opens it (or closes the drawer when it is the
    // page showing) — visible even while the drawer is fully closed (they
    // live on the viewport edge, so the sliding drawer can't clip them).
    this.drawerTabs = el("div", { class: "drawer-tabs" });
    this.registerDrawerPage({ id: "bits", label: "Track bits", element: el("div", { class: "drawer-page" }) });

    root.append(
      this.menubar,
      el("div", { class: "main" },
        this.rail,
        this.drawer,
        el("div", { class: "viewport-wrap" }, this.canvas, this.hud, this.viewportCorner, this.drawerTabs),
        this.right,
      ),
      el("div", { class: "statusbar" }, this.statusText, this.statusInfo, this.statusActions),
    );

    try {
      const saved = Number(localStorage.getItem("trackedit.drawerWidth"));
      if (Number.isFinite(saved) && saved > 0) this.drawerWidth = saved;
    } catch { /* storage unavailable */ }
    this.drawerWidth = Math.min(Math.max(this.drawerWidth, 220), 520);
    this.buildDrawerGrip();
    this.applyDrawer();
  }

  /** Slide the drawer in/out on whatever page is showing. */
  setDrawerOpen(open: boolean): void {
    this.drawerOpen = open;
    this.applyDrawer();
  }

  /** Add a page to the drawer with its own seam tab. */
  registerDrawerPage(def: { id: string; label: string; element: HTMLElement }): void {
    const icon = el("span", { class: "drawer-tab-icon" }, "▸");
    const tab = el("button", { class: "drawer-tab", title: `Toggle the ${def.label} panel` },
      icon, el("span", { class: "drawer-tab-label" }, def.label));
    const page: DrawerPage = { ...def, tab, icon, enabled: true };
    tab.addEventListener("click", () => {
      if (!page.enabled) return;
      if (this.drawerOpen && this.activePage === def.id) this.setDrawerOpen(false);
      else this.openDrawerPage(def.id);
    });
    def.element.classList.add("drawer-page");
    this.pages.push(page);
    this.drawerTabs.append(tab);
    this.drawer.append(def.element);
    this.applyDrawer();
  }

  /** Show a page and make sure the drawer is open. */
  openDrawerPage(id: string): void {
    if (this.pages.some((p) => p.id === id)) this.activePage = id;
    this.drawerOpen = true;
    this.applyDrawer();
  }

  /** Grey a page's tab out (e.g. TMX info when the map is not from TMX). */
  setDrawerPageEnabled(id: string, enabled: boolean): void {
    const page = this.pages.find((p) => p.id === id);
    if (!page || page.enabled === enabled) return;
    page.enabled = enabled;
    if (!enabled && this.drawerOpen && this.activePage === id) this.drawerOpen = false;
    this.applyDrawer();
  }

  private applyDrawer(): void {
    this.drawer.classList.toggle("open", this.drawerOpen);
    this.drawer.style.width = this.drawerOpen ? `${this.drawerWidth}px` : "0px";
    this.drawer.style.setProperty("--drawer-w", `${this.drawerWidth}px`);
    for (const p of this.pages) {
      const showing = this.drawerOpen && p.id === this.activePage;
      p.element.hidden = p.id !== this.activePage;
      p.tab.classList.toggle("active", showing);
      p.tab.classList.toggle("disabled", !p.enabled);
      p.tab.setAttribute("aria-disabled", String(!p.enabled));
      p.icon.textContent = showing ? "◂" : "▸";
    }
  }

  /** Drag the drawer's right edge to resize; width persists per browser. */
  private buildDrawerGrip(): void {
    const grip = el("div", { class: "drawer-grip" });
    let dragging = false;
    grip.addEventListener("pointerdown", (e) => {
      dragging = true;
      grip.setPointerCapture(e.pointerId);
      this.drawer.classList.add("dragging");
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const left = this.drawer.getBoundingClientRect().left;
      this.drawerWidth = Math.min(Math.max(e.clientX - left, 220), 520);
      this.applyDrawer();
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.drawer.classList.remove("dragging");
      try {
        localStorage.setItem("trackedit.drawerWidth", String(this.drawerWidth));
      } catch { /* storage unavailable */ }
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    this.drawer.append(grip);
  }

  registerPanel(panel: PanelDef): void {
    this.panels.push(panel);
    const host = panel.side === "left" ? this.pages[0].element : this.right;
    const wrap = el("section", { class: "panel", "data-panel": panel.id },
      panel.title ? el("header", {}, el("span", { class: "panel-title" }, panel.title), panel.actions ?? null) : null,
      panel.element,
    );
    wrap.style.order = String(panel.order ?? 50);
    host.append(wrap);
  }

  setStatus(text: string): void {
    this.statusText.textContent = text;
  }

  setHud(lines: Array<[string, string]> | null): void {
    if (!lines || lines.length === 0) {
      this.hud.style.display = "none";
      return;
    }
    clear(this.hud);
    for (const [strong, plain] of lines) {
      this.hud.append(
        el("div", { class: "hud-line" },
          el("span", { class: "hud-strong" }, strong),
          plain ? el("span", { class: "hud-plain" }, plain) : null,
        ),
      );
    }
    this.hud.style.display = "block";
  }
}
