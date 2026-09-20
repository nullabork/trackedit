import type { EditorContext } from "@plugins/api";
import { lineHue } from "@core/layer";
import type { Shell } from "./Shell";
import { clear, el } from "./dom";
import { ageText } from "@io/ghostCache";
import {
  activeGhostKeys, clearGhosts, fetchNadeoFinishes, fetchNadeoGhost, fetchTmxGhost, fetchTmxInfo, formatRaceTime,
  listNadeoRecords, listTmxReplays, nadeoConfigured, removeGhost, searchNadeoRecords, tmxIdOf,
} from "./ghostActions";
import type { NadeoRecordInfo, TmxMapInfo, TmxReplayInfo } from "./ghostActions";

const TMX = "https://trackmania.exchange";
const SERVER_ACCOUNT_URL = "https://www.trackmania.com/player/dedicated-servers";

/**
 * The "TM Exchange" drawer page: the open map's TMX card (name, links,
 * medals, stats, uploader), and every driving line available for it — the
 * map's own validation ghost, the TMX replays and the Nadeo world top 10.
 * Rows toggle: any number of lines can show at once on the active layer.
 * Greyed out unless the map came from TMX.
 */
export function buildTmxPanel(ctx: EditorContext, shell: Shell): void {
  const root = el("div", { class: "tmx-panel" });
  shell.registerDrawerPage({ id: "tmx", label: "TM Exchange", element: root });

  let shownId: number | null = null;
  let generation = 0;
  /** Rows by line key, so toggling state can be refreshed cheaply. */
  const rows = new Map<string, HTMLElement>();
  const busy = new Set<string>();

  const link = (href: string, text: string) => el("a", { href, target: "_blank", rel: "noopener" }, text);
  const date = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

  const syncRows = () => {
    const layer = ctx.document.activeLayer;
    const keys = activeGhostKeys(ctx, layer.id);
    const order = layer.ghosts.map((g) => g.key);
    for (const [key, row] of rows) {
      const on = keys.has(key);
      row.classList.toggle("active", on);
      const swatch = row.querySelector<HTMLElement>(".tmx-swatch");
      if (swatch) swatch.style.background = on ? lineHue(order.indexOf(key)) : "";
    }
  };

  /** A toggle row: click adds the line (fetching it) or removes it. */
  const lineRow = (key: string, cells: HTMLElement[], load: (layerId: string) => Promise<string>) => {
    const row = el("div", { class: "row tmx-row", "data-key": key }, el("span", { class: "tmx-swatch" }), ...cells);
    row.addEventListener("click", async () => {
      if (busy.has(key)) return;
      const layer = ctx.document.activeLayer;
      if (activeGhostKeys(ctx, layer.id).has(key)) {
        removeGhost(ctx, layer.id, key);
        syncRows();
        return;
      }
      busy.add(key);
      row.classList.add("loading");
      const msg = await load(layer.id);
      ctx.ui.setStatus(msg);
      row.classList.remove("loading");
      busy.delete(key);
      syncRows();
    });
    rows.set(key, row);
    return row;
  };

  const render = async () => {
    const gen = ++generation;
    clear(root);
    rows.clear();
    const mapId = shownId;
    if (mapId === null) {
      root.append(el("p", { class: "tmx-note" }, "Open a map from TMX (File ▸ Open from TMX…) to see its TMX card, replays and records here."));
      return;
    }
    const head = el("div", {}, el("h2", {}, ctx.document.name));
    const buttons = el("div", { class: "tmx-buttons" },
      link(`${TMX}/maps/${mapId}`, "TMX page ↗"),
      el("a", { class: "btn primary", href: `trackmania://openplanet/play/mx/${mapId}`, title: "Needs the game and Openplanet running" }, "Play in game"),
    );
    const stats = el("table", { class: "tmx-stats" });
    const status = el("div", { class: "tmx-status" }, el("span", { class: "spinner" }), el("span", {}, " Fetching TMX card…"));
    const linesHeader = el("div", { class: "tmx-section" }, "Driving lines");
    const linesNote = el("p", { class: "tmx-note" },
      `Click a row to show or hide its line on layer "${ctx.document.activeLayer.name}". Any number can show at once.`);
    const clearBtn = el("button", { class: "btn" }, "Hide all lines") as HTMLButtonElement;
    clearBtn.addEventListener("click", () => { clearGhosts(ctx, ctx.document.activeLayer.id); syncRows(); });
    const replayStatus = el("div", { class: "tmx-status" }, el("span", { class: "spinner" }), el("span", {}, " Fetching replays…"));
    const replayList = el("div", { class: "tmx-list rows" });
    const recordStatus = el("div", { class: "tmx-status" }, el("span", { class: "spinner" }), el("span", {}, " Fetching records…"));
    const recordList = el("div", { class: "tmx-list rows" });
    // Refresh: the list comes from the browser cache after a reload; this asks Nadeo again.
    const refreshBtn = el("button", { class: "btn icon", title: "Fetch the records again (you just set a time?)", "aria-label": "Refresh records" }, "\u27F3") as HTMLButtonElement;
    const searchBtn = el("button", { class: "btn icon", title: "Find a player's record by name", "aria-label": "Search a player" }, "\u{1F50D}\uFE0E") as HTMLButtonElement;
    const searchInput = el("input", { type: "search", class: "grow", placeholder: "Player name (start of it)\u2026", spellcheck: "false" }) as HTMLInputElement;
    const searchGo = el("button", { class: "btn" }, "Search") as HTMLButtonElement;
    const searchBox = el("form", { class: "tmx-actions tmx-search", hidden: "" }, searchInput, searchGo) as HTMLFormElement;
    const searchStatus = el("div", { class: "tmx-status", hidden: "" });
    const searchList = el("div", { class: "tmx-list rows" });
    root.append(head, buttons, status, stats,
      linesHeader, linesNote, el("div", { class: "tmx-actions" }, clearBtn),
      el("div", { class: "tmx-section" }, "Map ghost & TMX replays"), replayStatus, replayList,
      el("div", { class: "tmx-section tmx-section-tools" }, el("span", { class: "grow" }, "Nadeo records (world top 10)"), refreshBtn, searchBtn),
      searchBox, searchStatus, searchList, recordStatus, recordList);

    // Map ghost row: known after import; older stored maps say "unknown".
    const mapRow = (present: boolean | null, authorTime: number) => {
      if (present === false) return el("p", { class: "tmx-note" }, "The map file has no validation ghost.");
      return lineRow("map", [
        el("span", { class: "grow" }, present ? "Validation ghost (the author's run in the map)" : "Validation ghost, if the map has one"),
        el("span", { class: "tmx-time" }, authorTime ? formatRaceTime(authorTime) : ""),
      ], (layerId) => fetchTmxGhost(ctx, mapId, layerId, { source: "map" }));
    };

    const replayRow = (r: TmxReplayInfo) => lineRow(`tmx:${r.replayId}`, [
      el("span", { class: "tmx-awards" }, r.position != null ? `#${r.position + 1}` : ""),
      el("span", { class: "grow" }, r.driver || `replay ${r.replayId}`),
      el("span", { class: "tmx-time" }, formatRaceTime(r.time)),
      el("span", { class: "tmx-date" }, date(r.at)),
    ], (layerId) => fetchTmxGhost(ctx, mapId, layerId, { replayId: r.replayId }));

    const recordRow = (mapUid: string, r: NadeoRecordInfo) => lineRow(`nadeo:${r.accountId}`, [
      el("span", { class: "grow tmx-name" }, r.name),
      el("span", { class: "tmx-awards" }, r.position ? `#${r.position}` : "\u2013"),
      el("span", { class: "tmx-time" }, formatRaceTime(r.time)),
      el("span", { class: "tmx-zone", title: r.zone }, r.zone),
    ], (layerId) => fetchNadeoGhost(ctx, mapUid, layerId, r));

    let uidResolve: (uid: string | null) => void = () => {};
    const uidFromTmx = new Promise<string | null>((r) => { uidResolve = r; });

    // --- card ---
    void (async () => {
      try {
        const info: TmxMapInfo = await fetchTmxInfo(mapId);
        if (gen !== generation) return;
        uidResolve(info.mapUid);
        clear(head);
        head.append(el("h2", {}, info.name));
        clear(status);
        const cell = (label: string, value: Node | string) => stats.append(el("tr", {}, el("td", {}, label), el("td", {}, value)));
        const person = (p: { name: string; userId: number | null }) =>
          p.userId ? link(`${TMX}/user/profile/${p.userId}`, p.name) : el("span", {}, p.name);
        cell("Uploader", person(info.uploader));
        const others = info.authors.filter((a) => a.userId !== info.uploader.userId);
        if (others.length) cell("Authors", el("span", {}, ...others.flatMap((a, i) => [i ? ", " : "", person(a)])));
        cell("Author time", formatRaceTime(info.medals.author));
        cell("Gold", formatRaceTime(info.medals.gold));
        cell("Silver", formatRaceTime(info.medals.silver));
        cell("Bronze", formatRaceTime(info.medals.bronze));
        const finishesCell = el("span", {}, "…");
        cell("Finishes (Nadeo records)", finishesCell);
        cell("Awards", String(info.awardCount));
        cell("TMX replays", String(info.replayCount));
        cell("Downloads", String(info.downloadCount));
        cell("Uploaded", date(info.uploadedAt));
        cell("Validation ghost", ctx.document.validationGhost === null ? "unknown (reopen from TMX to check)" : ctx.document.validationGhost ? "in the map" : "none");
        cell("Ghost blocks", info.hasGhostBlocks ? "yes" : "no");
        if (info.embeddedObjects) cell("Embedded objects", String(info.embeddedObjects));
        if (info.tags.length) cell("Tags", info.tags.join(", "));
        const uid = ctx.document.mapUid ?? info.mapUid;
        if (uid) {
          void fetchNadeoFinishes(uid).then((n) => {
            if (gen !== generation) return;
            finishesCell.textContent = n === null ? "needs a Nadeo account" : n >= 10001 ? "10000+" : String(n);
          });
        } else finishesCell.textContent = "map uid unknown";
      } catch (err) {
        if (gen !== generation) return;
        uidResolve(null);
        status.textContent = `Could not fetch the TMX card: ${err instanceof Error ? err.message : err}`;
      }
    })();

    // --- map ghost + TMX replays ---
    void (async () => {
      try {
        const { authorTime, replays } = await listTmxReplays(mapId);
        if (gen !== generation) return;
        clear(replayList);
        replayList.append(mapRow(ctx.document.validationGhost, authorTime));
        replays.sort((a, b) => a.time - b.time);
        for (const r of replays) replayList.append(replayRow(r));
        replayStatus.textContent = replays.length
          ? `${replays.length} replay${replays.length === 1 ? "" : "s"} on TMX`
          : "No replays with a file on TMX.";
        syncRows();
      } catch (err) {
        if (gen !== generation) return;
        replayStatus.textContent = `Could not list replays: ${err instanceof Error ? err.message : err}`;
      }
    })();

    // --- Nadeo top 10 ---
    const mapUidReady = (async () => ctx.document.mapUid ?? (await uidFromTmx))();
    const loadRecords = async (fresh: boolean) => {
      refreshBtn.disabled = true;
      try {
        if (!(await nadeoConfigured())) {
          if (gen !== generation) return;
          clear(recordStatus);
          recordStatus.append("Needs a Nadeo account: create a free dedicated server account at ",
            link(SERVER_ACCOUNT_URL, "trackmania.com"), " and put its login in .trackedit.local.json (see README).");
          searchBtn.disabled = true;
          return;
        }
        const mapUid = await mapUidReady;
        if (gen !== generation) return;
        if (!mapUid) { recordStatus.textContent = "The map's game uid is unknown."; searchBtn.disabled = true; return; }
        if (fresh) { clear(recordStatus); recordStatus.append(el("span", { class: "spinner" }), el("span", {}, " Fetching records\u2026")); }
        const { records, at, cached } = await listNadeoRecords(mapUid, 10, fresh);
        if (gen !== generation) return;
        for (const r of recordList.querySelectorAll<HTMLElement>("[data-key]")) rows.delete(r.dataset.key!);
        clear(recordList);
        for (const r of records) recordList.append(recordRow(mapUid, r));
        recordStatus.textContent = (records.length ? `Top ${records.length} world records` : "No records on Nadeo's leaderboard for this map.") +
          (cached ? ` \u2014 saved ${ageText(at)}, \u27F3 to fetch again` : "");
        syncRows();
      } catch (err) {
        if (gen !== generation) return;
        recordStatus.textContent = `Could not list records: ${err instanceof Error ? err.message : err}`;
      } finally {
        if (gen === generation) refreshBtn.disabled = false;
      }
    };
    refreshBtn.addEventListener("click", () => void loadRecords(true));
    void loadRecords(false);

    // --- player search ---
    searchBtn.addEventListener("click", () => {
      searchBox.hidden = !searchBox.hidden;
      if (!searchBox.hidden) searchInput.focus();
    });
    searchBox.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = searchInput.value.trim();
      const mapUid = await mapUidReady;
      if (!mapUid || gen !== generation) return;
      searchStatus.hidden = false;
      if (name.length < 2) { searchStatus.textContent = "Type at least two characters."; return; }
      searchGo.disabled = true;
      clear(searchStatus);
      searchStatus.append(el("span", { class: "spinner" }), el("span", {}, ` Looking for "${name}"\u2026`));
      try {
        const found = await searchNadeoRecords(mapUid, name);
        if (gen !== generation) return;
        for (const r of searchList.querySelectorAll<HTMLElement>("[data-key]")) if (!recordList.querySelector(`[data-key="${CSS.escape(r.dataset.key!)}"]`)) rows.delete(r.dataset.key!);
        clear(searchList);
        // A player already listed in the top 10 keeps that row; the rest get one here.
        const extra = found.records.filter((r) => !recordList.querySelector(`[data-key="${CSS.escape(`nadeo:${r.accountId}`)}"]`));
        for (const r of extra) searchList.append(recordRow(mapUid, r));
        const inTop = found.records.length - extra.length;
        // Point at the ones that were in the list all along.
        for (const r of found.records) {
          const row = recordList.querySelector<HTMLElement>(`[data-key="${CSS.escape(`nadeo:${r.accountId}`)}"]`);
          if (!row) continue;
          row.classList.add("current");
          row.scrollIntoView({ block: "nearest" });
          window.setTimeout(() => row.classList.remove("current"), 2500);
        }
        searchStatus.textContent = found.records.length
          ? `${found.records.length} record${found.records.length === 1 ? "" : "s"} by players matching "${name}"${inTop ? ` (${inTop} already in the top 10 below)` : ""}`
          : found.matched
            ? `${found.matched} player${found.matched === 1 ? "" : "s"} match "${name}", none has a record on this map.`
            : `No player found for "${name}". The search matches the START of a name${found.via.includes("trackmania.io") ? "" : " (trackmania.io could not be reached)"}.`;
        syncRows();
      } catch (err) {
        if (gen !== generation) return;
        searchStatus.textContent = `Search failed: ${err instanceof Error ? err.message : err}`;
      } finally {
        searchGo.disabled = false;
      }
    });
  };

  const refresh = () => {
    const id = tmxIdOf(ctx);
    shell.setDrawerPageEnabled("tmx", id !== null);
    if (id === shownId) { syncRows(); return; }
    shownId = id;
    void render();
  };
  ctx.document.events.on("reset", refresh);
  ctx.document.events.on("mapChanged", refresh);
  ctx.document.events.on("layerChanged", syncRows);
  ctx.document.events.on("activeLayerChanged", syncRows);
  refresh();
}
