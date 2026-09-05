import type { EditorContext } from "@plugins/api";
import type { BlockDef } from "@core/catalog";
import { clear, el } from "./dom";
import { FILTER_STRIP, buildTagIndex, tagDef } from "./tags";

const MAX_RESULTS = 300;

/**
 * The block drawer (style guide §5.2): search → TRACK|ITEMS tabs → tag
 * filter strip → rows with colored tag chips. Clicking a row arms the place
 * tool.
 */
export function createPalettePanel(ctx: EditorContext): HTMLElement {
  const tagIndex = buildTagIndex(ctx.catalog);
  let kind: "block" | "item" = "block";
  let armed: string | null = null;
  const activeTags = new Set<string>();

  const search = el("input", {
    type: "search",
    class: "input",
    placeholder: `Search ${ctx.catalog.defs.length} blocks…`,
  });

  const tabTrack = el("div", { class: "tab active", onclick: () => setKind("block") }, "Track");
  const tabItems = el("div", { class: "tab", onclick: () => setKind("item") }, "Items");
  const setKind = (k: "block" | "item") => {
    kind = k;
    tabTrack.classList.toggle("active", k === "block");
    tabItems.classList.toggle("active", k === "item");
    render();
  };

  const tagStrip = el("div", { class: "tagstrip" });
  for (const id of FILTER_STRIP) {
    const t = tagDef(id);
    if (!t) continue;
    const chipEl = chip(id, t.label, t.color);
    chipEl.classList.add("clickable");
    chipEl.addEventListener("click", () => {
      if (activeTags.has(id)) activeTags.delete(id);
      else activeTags.add(id);
      chipEl.classList.toggle("on", activeTags.has(id));
      render();
    });
    tagStrip.append(chipEl);
  }

  const count = el("div", { class: "palette-count" });
  const list = el("div", { class: "rows" });

  const matches = (def: BlockDef): boolean => {
    if ((def.kind === "item") !== (kind === "item")) return false;
    if (activeTags.size > 0) {
      const tags = tagIndex.get(def.name) ?? [];
      for (const t of activeTags) if (!tags.includes(t)) return false;
    }
    return true;
  };

  const render = () => {
    const q = search.value;
    const results = ctx.catalog.search(q).filter(matches);
    clear(list);
    count.textContent =
      results.length > MAX_RESULTS
        ? `${results.length} matches · showing ${MAX_RESULTS}`
        : `${results.length} matches`;
    for (const def of results.slice(0, MAX_RESULTS)) list.append(row(def));
  };

  const row = (def: BlockDef) => {
    const tags = (tagIndex.get(def.name) ?? []).slice(0, 2);
    const node = el("div", {
      class: `row${def.name === armed ? " armed" : ""}`,
      title: `${def.name} · used ${def.uses}×`,
      onclick: () => {
        armed = def.name;
        ctx.events.emit("blockArmed", { name: def.name });
        ctx.ui.setStatus(`Placing ${def.label}`);
        for (const other of list.querySelectorAll(".armed")) other.classList.remove("armed");
        node.classList.add("armed");
      },
    },
      el("span", { class: "grow" }, def.label),
      ...tags.map((id) => {
        const t = tagDef(id);
        return t ? chip(id, t.label, t.color) : null;
      }),
    );
    return node;
  };

  search.addEventListener("input", render);
  render();

  return el("div", { class: "palette" }, search, el("div", { class: "tabs" }, tabTrack, tabItems), tagStrip, count, list);
}

function chip(id: string, label: string, color: string): HTMLElement {
  const node = el("span", { class: `tag tag-${id}` }, el("span", {}, label));
  if (id === "finish") node.classList.add("checker");
  else node.style.setProperty("--c", color);
  return node;
}
