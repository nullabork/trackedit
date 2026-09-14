import type { EditorContext } from "@plugins/api";
import { clear, el } from "./dom";
import { openDialog } from "./dialog";
import {
  fetchNadeoGhost, fetchTmxGhost, formatRaceTime, hideGhost, listNadeoRecords, listTmxReplays,
  nadeoConfigured, tmxIdOf,
} from "./ghostActions";
import type { NadeoRecordInfo, TmxReplayInfo } from "./ghostActions";

const SERVER_ACCOUNT_URL = "https://www.trackmania.com/player/dedicated-servers";

/**
 * Driving lines for the open TMX map: its own validation ghost, the TMX
 * replays, and the world records from Nadeo's leaderboard (what the game
 * lists in single player). Click one to draw it on the active layer. A
 * layer shows one line at a time, so loading a line hides the previous
 * one; **Hide** removes it.
 */
export function openReplayDialog(ctx: EditorContext): void {
  const mapId = tmxIdOf(ctx);
  if (mapId === null) {
    ctx.ui.setStatus("Replays come from TMX — open a map with File ▸ Open from TMX first.");
    return;
  }
  const layer = ctx.document.activeLayer;
  const status = el("div", { class: "tmx-status" }, el("span", { class: "spinner" }), el("span", {}, " Fetching replays…"));
  const replayList = el("div", { class: "tmx-list rows" });
  const recordStatus = el("div", { class: "tmx-status" }, el("span", { class: "spinner" }), el("span", {}, " Fetching records…"));
  const recordList = el("div", { class: "tmx-list rows" });
  const hideBtn = el("button", { class: "btn" }, "Hide line") as HTMLButtonElement;
  let busy = false;

  const current = () => ctx.document.getLayer(layer.id)?.ghost;
  const refreshCurrent = () => {
    const g = current();
    hideBtn.disabled = !g;
    for (const row of [...replayList.querySelectorAll<HTMLElement>(".tmx-row"), ...recordList.querySelectorAll<HTMLElement>(".tmx-row")]) {
      const isCurrent = !!g && (
        row.dataset.source === "map" ? g.source === "map"
        : row.dataset.account ? g.source === "nadeo" && g.accountId === row.dataset.account
        : g.source === "tmx" && g.replayId === Number(row.dataset.replay));
      row.classList.toggle("current", isCurrent);
    }
  };

  /** Run one line load with the busy/status choreography shared by every row. */
  const load = async (row: HTMLElement, list: HTMLElement, out: HTMLElement, work: () => Promise<string>) => {
    if (busy) return;
    busy = true;
    row.classList.add("loading");
    list.classList.add("busy");
    clear(out);
    out.append(el("span", { class: "spinner" }), el("span", {}, " Downloading and extracting the line…"));
    const msg = await work();
    out.textContent = msg;
    ctx.ui.setStatus(msg);
    row.classList.remove("loading");
    list.classList.remove("busy");
    busy = false;
    refreshCurrent();
  };

  const replayRow = (r: TmxReplayInfo) => {
    const node = el("div", { class: "row tmx-row", "data-replay": String(r.replayId) },
      el("span", { class: "tmx-awards" }, r.position != null ? `#${r.position + 1}` : ""),
      el("span", { class: "grow" }, r.driver || `replay ${r.replayId}`),
      el("span", { class: "tmx-time" }, formatRaceTime(r.time)),
      el("span", { class: "tmx-date" }, r.at ? r.at.slice(0, 10) : ""),
    );
    node.addEventListener("click", () => void load(node, replayList, status,
      () => fetchTmxGhost(ctx, mapId, layer.id, { replayId: r.replayId })));
    return node;
  };

  const recordRow = (mapUid: string, r: NadeoRecordInfo) => {
    const node = el("div", { class: "row tmx-row", "data-account": r.accountId },
      el("span", { class: "grow tmx-name" }, r.name),
      el("span", { class: "tmx-awards" }, `#${r.position}`),
      el("span", { class: "tmx-time" }, formatRaceTime(r.time)),
      el("span", { class: "tmx-zone", title: r.zone }, r.zone),
    );
    node.addEventListener("click", () => void load(node, recordList, recordStatus,
      () => fetchNadeoGhost(ctx, mapUid, layer.id, r)));
    return node;
  };

  hideBtn.addEventListener("click", () => {
    hideGhost(ctx, layer.id);
    status.textContent = "Ghost line hidden.";
    refreshCurrent();
  });

  openDialog({
    title: `Replays · TMX #${mapId}`,
    width: 560,
    content: el("div", { class: "tmx-dialog" },
      el("p", { class: "hint" },
        `Lines are drawn on layer "${layer.name}". Loading one replaces the line that is showing.`),
      el("div", { class: "tmx-section" }, "TMX replays"),
      status,
      replayList,
      el("div", { class: "tmx-section" }, "Nadeo records (in-game leaderboard)"),
      recordStatus,
      recordList,
      el("div", { class: "tmx-actions" }, hideBtn,
        el("span", { class: "hint" }, "Time closest to the author medal is loaded automatically on import.")),
    ),
  });

  // The game's map uid keys the record services. TMX import stores it on
  // the document; maps stored before that resolve it through TMX.
  let resolveUid: (uid: string | null) => void = () => {};
  const uidFromTmx = new Promise<string | null>((r) => { resolveUid = r; });

  void (async () => {
    try {
      const { authorTime, mapUid, replays } = await listTmxReplays(mapId);
      resolveUid(mapUid);
      clear(replayList);
      const mapRow = el("div", { class: "row tmx-row", "data-source": "map" },
        el("span", { class: "tmx-awards" }, "map"),
        el("span", { class: "grow" }, "Validation ghost (the author's run stored in the map)"),
        el("span", { class: "tmx-time" }, authorTime ? formatRaceTime(authorTime) : ""),
        el("span", { class: "tmx-date" }, ""),
      );
      mapRow.addEventListener("click", () => void load(mapRow, replayList, status,
        () => fetchTmxGhost(ctx, mapId, layer.id, { source: "map" })));
      replayList.append(mapRow);
      replays.sort((a, b) => a.time - b.time);
      for (const r of replays) replayList.append(replayRow(r));
      status.textContent = replays.length
        ? `${replays.length} replay${replays.length === 1 ? "" : "s"} with a file` +
          (authorTime ? ` · author time ${formatRaceTime(authorTime)}` : "")
        : "No replays with a file on TMX — only the map's own ghost, if it has one.";
      refreshCurrent();
    } catch (err) {
      resolveUid(null);
      status.textContent = `Could not list replays: ${err instanceof Error ? err.message : err}`;
    }
  })();

  void (async () => {
    try {
      if (!(await nadeoConfigured())) {
        clear(recordStatus);
        recordStatus.append(
          "Needs a Nadeo account: create a free dedicated server account at ",
          el("a", { href: SERVER_ACCOUNT_URL, target: "_blank", rel: "noopener" }, SERVER_ACCOUNT_URL),
          " and put its login in .trackedit.local.json (see README).",
        );
        return;
      }
      const mapUid = ctx.document.mapUid ?? (await uidFromTmx);
      if (!mapUid) {
        recordStatus.textContent = "The map's game uid is unknown — reopen it from TMX to look up records.";
        return;
      }
      const records = await listNadeoRecords(mapUid);
      clear(recordList);
      for (const r of records) recordList.append(recordRow(mapUid, r));
      recordStatus.textContent = records.length
        ? `${records.length} world record${records.length === 1 ? "" : "s"}`
        : "No records on Nadeo's leaderboard for this map.";
      refreshCurrent();
    } catch (err) {
      recordStatus.textContent = `Could not list records: ${err instanceof Error ? err.message : err}`;
    }
  })();
}
