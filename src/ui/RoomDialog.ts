import type { EditorContext } from "@plugins/api";
import type { Room, RoomRef } from "@core/roomTracking";
import { POLL_MS } from "@core/roomTracking";
import { fetchRoom, getRoomTracker, searchRooms } from "@plugins/roomTracker";
import { clear, el } from "./dom";
import { openDialog } from "./dialog";
import { fetchNadeoMapInfo } from "./tmxOpen";
import type { NadeoMapInfo } from "./tmxOpen";
import { formatRaceTime } from "./ghostActions";

const sameRoom = (a: RoomRef | null, b: RoomRef | null): boolean =>
  !!a && !!b && a.clubId === b.clubId && a.activityId === b.activityId;

/**
 * Track a server: search the game's club rooms by name, pick one, and "Start
 * tracking" opens the map it is playing — and the next one whenever it moves on
 * (plugins/roomTracker.ts). Tracking carries on with the dialog closed.
 */
export function openRoomDialog(ctx: EditorContext): void {
  const tracker = getRoomTracker(ctx);
  const search = el("input", { class: "input", type: "search", placeholder: "Server (club room) name…", spellcheck: "false" }) as HTMLInputElement;
  const goBtn = el("button", { class: "btn primary" }, "Search") as HTMLButtonElement;
  const status = el("div", { class: "tmx-status" }, "Search the game's club rooms by name — any part of it (\"night together\").");
  const list = el("div", { class: "tmx-list rows room-list" });
  const card = el("div", { class: "room-card" });
  let selected: RoomRef | null = tracker.tracked;
  let cardGen = 0;
  let busy = false;
  const mapInfos = new Map<string, Promise<NadeoMapInfo | null>>();

  const dialog = openDialog({
    title: "Track a server",
    content: el("div", { class: "tmx-dialog" }, el("div", { class: "tmx-search" }, search, goBtn), status, list, card),
    width: 560,
  });

  /** The selected room: what it is playing now, and the tracking button. */
  const renderCard = () => {
    const gen = ++cardGen;
    clear(card);
    const room = selected;
    if (!room) return;
    const tracking = sameRoom(tracker.tracked, room);
    const playing = el("div", { class: "tmx-note" }, el("span", { class: "spinner" }), " Asking Nadeo what it is playing…");
    const btn = el("button", { class: `btn ${tracking ? "danger" : "primary"}` }, tracking ? "Stop tracking" : "Start tracking") as HTMLButtonElement;
    btn.addEventListener("click", () => (tracking ? tracker.stop() : tracker.start(room)));
    card.append(
      el("div", { class: "room-head" },
        el("div", { class: "grow" }, el("h2", {}, room.name), el("div", { class: "tmx-note" }, room.clubName)),
        btn),
      playing,
      tracking ? el("div", { class: "tmx-note room-note" }, tracker.loading ? el("span", { class: "spinner" }) : null, ` ${tracker.note}`) : "",
      el("div", { class: "tmx-note" }, tracking
        ? `Checked every ${POLL_MS / 1000} s. Tracking carries on with this dialog closed; the map it moves to opens by itself.`
        : `Start tracking opens the map the server is playing, and every map it moves to (checked every ${POLL_MS / 1000} s).`),
    );
    // While tracking, the tracker's own last answer is the freshest there is — no second request.
    const state = tracking && tracker.state ? Promise.resolve(tracker.state) : fetchRoom(room);
    void state.then(async (s) => {
      if (gen !== cardGen) return;
      const players = `${s.playerCount}/${s.maxPlayers} players`;
      if (!s.nadeoHosted && !s.currentMapUid) { playing.textContent = `${players}. It runs on a player's own server: Nadeo does not say which map it is playing, so it cannot be tracked.`; btn.disabled = !tracking; return; }
      if (!s.currentMapUid) { playing.textContent = `${players}. The server is off (a room stops when it is empty); ${s.maps.length} map${s.maps.length === 1 ? "" : "s"} in its playlist. Tracking waits for it to start.`; return; }
      playing.textContent = `${players}. Playing…`;
      // The card redraws on every poll; a uid names one file, so its card is asked for once.
      let asked = mapInfos.get(s.currentMapUid);
      if (!asked) mapInfos.set(s.currentMapUid, asked = fetchNadeoMapInfo(s.currentMapUid).catch(() => null));
      const info = await asked;
      if (gen !== cardGen) return;
      playing.textContent = info
        ? `${players}. Playing ${info.name} — author time ${formatRaceTime(info.authorTime)}${info.tmxId !== null ? `, TMX #${info.tmxId}` : ", not on TMX"}.`
        : `${players}. Playing map ${s.currentMapUid}.`;
    }).catch((err) => {
      if (gen === cardGen) playing.textContent = `Could not ask Nadeo: ${err instanceof Error ? err.message : err}`;
    });
  };

  const roomRow = (r: Room) => {
    const row = el("div", { class: `row tmx-row${sameRoom(selected, r) ? " current" : ""}` },
      el("span", { class: "grow" }, r.name),
      el("span", { class: "tmx-author" }, r.clubName),
      el("span", { class: "tmx-awards", title: r.nadeoHosted ? "" : "A player's own server: its map cannot be read" }, r.nadeoHosted ? "" : "own server"),
      el("span", { class: "tmx-time" }, `${r.playerCount}/${r.maxPlayers}`),
    );
    row.addEventListener("click", () => {
      selected = r;
      for (const other of list.children) other.classList.toggle("current", other === row);
      renderCard();
    });
    return row;
  };

  const runSearch = async () => {
    const name = search.value.trim();
    if (busy) return;
    if (name.length < 2) { status.textContent = "Type at least two characters."; return; }
    busy = true;
    clear(status);
    status.append(el("span", { class: "spinner" }), el("span", {}, " Searching…"));
    clear(list);
    try {
      const { rooms, total } = await searchRooms(name);
      status.textContent = rooms.length
        ? `${total > rooms.length ? `The ${rooms.length} busiest of ${total}` : `${rooms.length}`} server${total === 1 ? "" : "s"} — busiest first.`
        : "No server with that in its name.";
      for (const r of rooms) list.append(roomRow(r));
    } catch (err) {
      status.textContent = `Search failed: ${err instanceof Error ? err.message : err}`;
    }
    busy = false;
  };

  goBtn.addEventListener("click", () => void runSearch());
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runSearch();
    e.stopPropagation();
  });
  // Keep the card live while the dialog is open; drop the listener once it is gone.
  const off = tracker.events.on("changed", () => {
    if (!card.isConnected) { off(); return; }
    renderCard();
  });
  renderCard();
  queueMicrotask(() => search.focus());
  void dialog;
}
