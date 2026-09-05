import type { EditorContext } from "@plugins/api";
import { deleteMap, listMaps, loadMap } from "@io/mapStore";
import { clear, el } from "./dom";
import { icon } from "./icons";
import { confirmDialog, openDialog } from "./dialog";
import { openNewMapDialog } from "./NewMapDialog";
import { applyStored } from "./session";

/** All locally saved tracks; click to open, ✕ to delete, New track on top. */
export function openMapBrowser(ctx: EditorContext): void {
  const list = el("div", { class: "rows browser-list" });
  const status = el("div", { class: "tmx-status" });

  const dialog = openDialog({
    title: "Your tracks",
    width: 460,
    content: el("div", { class: "tmx-dialog" },
      el("button", {
        class: "btn primary",
        onclick: () => {
          dialog.close();
          openNewMapDialog(ctx);
        },
      }, "+ New track"),
      status,
      list,
    ),
  });

  const fmtAge = (t: number) => {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 60 / 24)}d ago`;
  };

  const refresh = async () => {
    const maps = await listMaps();
    clear(list);
    status.textContent = maps.length
      ? `${maps.length} saved track${maps.length === 1 ? "" : "s"}`
      : "No saved tracks yet — create one or open a map from TMX.";
    for (const m of maps) {
      const del = el("button", { class: "layer-btn", title: "Delete track" }, icon("x"));
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog({
          title: "Delete track",
          message: `Delete "${m.name}" (${m.placementCount} placements) from local storage? This cannot be undone.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (ok) {
          await deleteMap(m.id);
          void refresh();
        }
      });
      const row = el("div", { class: "row browser-row" },
        el("span", { class: "grow" }, m.name),
        el("span", { class: "browser-meta" }, `${m.placementCount}`),
        el("span", { class: "browser-meta" }, fmtAge(m.updatedAt)),
        del,
      );
      row.addEventListener("click", async () => {
        const rec = await loadMap(m.id);
        if (!rec) {
          status.textContent = "Could not load that track.";
          return;
        }
        applyStored(ctx, rec);
        dialog.close();
      });
      list.append(row);
    }
  };
  void refresh();
}
