import type { EditorContext } from "@plugins/api";
import { clear, el } from "./dom";
import { openDialog } from "./dialog";
import { openTmxMap } from "./tmxOpen";

interface TmxResult {
  MapId: number;
  Name: string;
  Uploader?: { Name?: string };
  AwardCount?: number;
}

/**
 * TrackmaniaExchange lookup: search by name, click a result to download it
 * through the dev-server bridge (TMX -> gbxdump -> dump JSON) and open it.
 */
export function openTmxDialog(ctx: EditorContext): void {
  const search = el("input", { class: "input", type: "search", placeholder: "Search TrackmaniaExchange…" });
  const goBtn = el("button", { class: "btn primary" }, "Search");
  const status = el("div", { class: "tmx-status" }, "Search for a map name — e.g. \"Majis Multiverse\".");
  const list = el("div", { class: "tmx-list rows" });
  let busy = false;

  const dialog = openDialog({
    title: "Open from TMX",
    content: el("div", { class: "tmx-dialog" },
      el("div", { class: "tmx-search" }, search, goBtn),
      status,
      list,
    ),
    width: 520,
  });

  const runSearch = async () => {
    if (busy || !search.value.trim()) return;
    busy = true;
    status.textContent = "Searching…";
    clear(list);
    try {
      const res = await fetch(`/api/tmx/search?q=${encodeURIComponent(search.value.trim())}`);
      const json = (await res.json()) as { Results?: TmxResult[]; error?: string };
      if (json.error) throw new Error(json.error);
      const results = json.Results ?? [];
      status.textContent = results.length ? `${results.length} maps` : "No maps found.";
      for (const r of results) list.append(resultRow(r));
    } catch (err) {
      status.textContent = `Search failed: ${err instanceof Error ? err.message : err}`;
    }
    busy = false;
  };

  const resultRow = (r: TmxResult) => {
    const row = el("div", { class: "row tmx-row" },
      el("span", { class: "grow" }, r.Name),
      el("span", { class: "tmx-author" }, r.Uploader?.Name ?? ""),
      el("span", { class: "tmx-awards" }, r.AwardCount ? `★ ${r.AwardCount}` : ""),
    );
    row.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      row.classList.add("loading");
      list.classList.add("busy");
      clear(status);
      status.append(
        el("span", { class: "spinner" }),
        el("span", {}, ` Downloading "${r.Name}" and parsing… big maps take a few seconds`),
      );
      try {
        await openTmxMap(ctx, r.MapId, r.Name);
        dialog.close();
      } catch (err) {
        status.textContent = `Load failed: ${err instanceof Error ? err.message : err}`;
        row.classList.remove("loading");
        list.classList.remove("busy");
        busy = false;
      }
    });
    return row;
  };

  goBtn.addEventListener("click", runSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
    e.stopPropagation();
  });
  queueMicrotask(() => search.focus());
}
