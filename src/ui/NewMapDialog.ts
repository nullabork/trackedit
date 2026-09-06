import type { EditorContext } from "@plugins/api";
import type { MapBase, Mood } from "@core/mapbase";
import { MAP_BASES, initialBuildLevel } from "@core/mapbase";
import { newId } from "@core/math";
import { el } from "./dom";
import { openDialog } from "./dialog";
import { baseListEl, moodRowEl } from "./mapFormParts";
import { persistNow, session } from "./session";

/**
 * New map: name (required — every track needs one so it can be saved),
 * map base and mood (both changeable later in Map settings).
 */
export function openNewMapDialog(ctx: EditorContext): void {
  let base: MapBase = MAP_BASES[0];
  let mood: Mood = "Day";

  const nameInput = el("input", {
    class: "input",
    type: "text",
    placeholder: "Track name (required)",
  });
  const bases = baseListEl((b) => b === base, (b) => (base = b));
  const moods = moodRowEl((m) => m === mood, (m) => (mood = m));

  const create = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return false;
    }
    ctx.document.id = newId("map");
    ctx.document.reset([], { name });
    ctx.document.setMapBase(base);
    ctx.document.setMood(mood);
    ctx.tools.setBuildLevel(initialBuildLevel(base.type));
    session.ready = true;
    void persistNow(ctx);
    ctx.ui.setStatus(`New track "${name}" on ${base.label} (${mood})`);
    return true;
  };

  const dialog = openDialog({
    title: "New map",
    width: 380,
    content: el("div", { class: "settings-dialog" },
      el("div", { class: "field" }, el("label", {}, "Track name"), nameInput),
      el("div", { class: "field" }, el("label", {}, "Map base"), bases.root),
      el("div", { class: "field" }, el("label", {}, "Mood"), moods.root),
    ),
    actions: [
      { label: "Cancel", onClick: () => undefined },
      { label: "Create", primary: true, onClick: () => create() },
    ],
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && create()) dialog.close();
    e.stopPropagation();
  });
  queueMicrotask(() => nameInput.focus());
}
