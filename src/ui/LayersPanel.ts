import type { EditorContext } from "@plugins/api";
import { AddLayerCmd, RemoveLayerCmd, UpdateLayerCmd } from "@core/commands";
import type { Layer } from "@core/layer";
import { createLayer } from "@core/layer";
import { clear, el } from "./dom";
import { icon } from "./icons";
import { confirmDialog } from "./dialog";

/**
 * Layers panel, split in two (style guide):
 * - top half: pinned "+ Add layer", then the layer list with its own
 *   scrollbar (inline rename on double-click, delete with warning);
 * - bottom half: always-visible settings with two tabs — GLOBAL (all-layer
 *   rules) and LAYER (the selected layer) — no gear buttons anywhere; the
 *   Layer tab simply follows the selection.
 */
export function createLayersPanel(ctx: EditorContext): HTMLElement {
  const doc = ctx.document;
  let renamingId: string | null = null;
  let tab: "global" | "layer" = "layer";

  const list = el("div", { class: "layer-list" });
  const settingsBody = el("div", { class: "layer-settings-body" });
  const tabGlobal = el("div", { class: "tab", onclick: () => setTab("global") }, "Global");
  const tabLayer = el("div", { class: "tab active", onclick: () => setTab("layer") }, "Layer");

  const setTab = (t: "global" | "layer") => {
    tab = t;
    tabGlobal.classList.toggle("active", t === "global");
    tabLayer.classList.toggle("active", t === "layer");
    renderSettings();
  };

  const iconBtn = (name: string, title: string, onclick: (e: MouseEvent) => void) => {
    const b = el("button", { class: "layer-btn", title }, icon(name));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onclick(e);
    });
    return b;
  };

  // --- layer list ---

  const commitRename = (layer: Layer, value: string) => {
    renamingId = null;
    const name = value.trim();
    if (name && name !== layer.name)
      ctx.history.run(new UpdateLayerCmd(layer.id, { name }, "Rename layer"));
    else renderAll();
  };

  const nameCell = (layer: Layer) => {
    if (renamingId === layer.id) {
      const input = el("input", { class: "layer-rename", type: "text", value: layer.name });
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commitRename(layer, input.value);
        else if (e.key === "Escape") {
          renamingId = null;
          renderAll();
        }
        e.stopPropagation();
      });
      input.addEventListener("blur", () => commitRename(layer, input.value));
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      return input;
    }
    const span = el("span", { class: "layer-name", title: "Double-click to rename" },
      layer.name,
      el("span", { class: "layer-count" }, ` ${layer.placements.size}`),
    );
    span.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      renamingId = layer.id;
      renderAll();
    });
    return span;
  };

  const deleteLayer = async (layer: Layer) => {
    if (doc.layers.length <= 1) {
      ctx.ui.setStatus("Can't delete the last layer");
      return;
    }
    const n = layer.placements.size;
    const ok = await confirmDialog({
      title: "Delete layer",
      message:
        `Delete layer "${layer.name}"${n ? ` and its ${n} placement${n === 1 ? "" : "s"}` : ""}? ` +
        `Undo with Ctrl+Z if you change your mind.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) ctx.history.run(new RemoveLayerCmd(layer.id));
  };

  const renderList = () => {
    clear(list);
    for (const layer of doc.layers) {
      const active = layer.id === doc.activeLayer.id;
      const row = el("div", { class: `layer-row${active ? " active" : ""}` },
        iconBtn(layer.visible ? "eye" : "eye-off", layer.visible ? "Hide layer" : "Show layer", () =>
          ctx.history.run(new UpdateLayerCmd(layer.id, { visible: !layer.visible }, "Toggle visibility")),
        ),
        nameCell(layer),
        iconBtn(layer.locked ? "lock" : "unlock", layer.locked ? "Unlock" : "Lock", () =>
          ctx.history.run(new UpdateLayerCmd(layer.id, { locked: !layer.locked }, "Toggle lock")),
        ),
        iconBtn("x", "Delete layer", () => deleteLayer(layer)),
      );
      row.addEventListener("click", () => doc.setActiveLayer(layer.id));
      list.append(row);
    }
  };

  // --- settings (bottom half) ---

  const num = (value: number, onchange: (v: number) => void, step = 1) => {
    const input = el("input", { type: "number", value: String(value), step: String(step) });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onchange(v);
    });
    return input;
  };

  /** Number input with an inline axis label (x:/y:/z:) overlaid at the start. */
  const axisNum = (axis: string, value: number, onchange: (v: number) => void, step = 1) =>
    el("span", { class: "axis-wrap" },
      el("i", {}, `${axis}:`),
      num(value, onchange, step),
    );

  const checkbox = (label: string, checked: boolean, disabled: boolean, onchange: (v: boolean) => void, title?: string) => {
    const input = el("input", { type: "checkbox" });
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener("change", () => onchange(input.checked));
    return el("label", { class: `check${disabled ? " disabled" : ""}`, title: title ?? "" }, input, el("span", {}, label));
  };

  const renderSettings = () => {
    clear(settingsBody);

    if (tab === "global") {
      settingsBody.append(
        checkbox(
          "Block sub-base rotation & translation (all layers)",
          doc.globalClampToBase,
          false,
          (v) => {
            doc.setGlobalClampToBase(v);
            renderSettings();
          },
          "Overrides every layer: planes auto-lift so they never dip below the base grid",
        ),
        el("p", { class: "hint" },
          "When on, rotating or moving ANY layer keeps its plane at or above the base grid — it keeps rotating but auto-translates up instead of going underground.",
        ),
      );
      return;
    }

    const layer = doc.activeLayer;
    const patchTransform = (t: Partial<Layer["transform"]>) =>
      ctx.history.run(
        new UpdateLayerCmd(layer.id, { transform: { ...layer.transform, ...t } }, "Layer transform"),
      );
    const patchStep = (axis: 0 | 1 | 2, v: number) => {
      const gridStep = [...layer.settings.gridStep] as [number, number, number];
      gridStep[axis] = v;
      ctx.history.run(
        new UpdateLayerCmd(layer.id, { settings: { ...layer.settings, gridStep } }, "Grid step"),
      );
    };
    const [tx, ty, tz] = layer.transform.translate;
    const [rx, ry, rz] = layer.transform.rotDeg;
    const globalOn = doc.globalClampToBase;

    settingsBody.append(
      el("h4", {}, layer.name),
      checkbox(
        "Block sub-base rotation & translation",
        globalOn || layer.clampToBase,
        globalOn,
        (v) => ctx.history.run(new UpdateLayerCmd(layer.id, { clampToBase: v }, "Sub-base clamp")),
        globalOn ? "Forced on by the global setting" : "This layer auto-lifts so its plane never dips below the base grid",
      ),
      el("div", { class: "field" },
        el("label", {}, "Grid step (m)"),
        el("div", { class: "row3" },
          axisNum("x", layer.settings.gridStep[0], (v) => patchStep(0, v), 4),
          axisNum("y", layer.settings.gridStep[1], (v) => patchStep(1, v), 1),
          axisNum("z", layer.settings.gridStep[2], (v) => patchStep(2, v), 4),
        ),
      ),
      el("div", { class: "field" },
        el("label", {}, "Translate (m)"),
        el("div", { class: "row3" },
          axisNum("x", tx, (v) => patchTransform({ translate: [v, ty, tz] }), 8),
          axisNum("y", ty, (v) => patchTransform({ translate: [tx, v, tz] }), 8),
          axisNum("z", tz, (v) => patchTransform({ translate: [tx, ty, v] }), 8),
        ),
      ),
      el("div", { class: "field" },
        el("label", {}, "Rotation (deg)"),
        el("div", { class: "row3" },
          axisNum("x", rx, (v) => patchTransform({ rotDeg: [v, ry, rz] }), 15),
          axisNum("y", ry, (v) => patchTransform({ rotDeg: [rx, v, rz] }), 15),
          axisNum("z", rz, (v) => patchTransform({ rotDeg: [rx, ry, v] }), 15),
        ),
      ),
      el("div", { class: "field" },
        el("label", {}, "LOD load distance (m)"),
        num(layer.settings.lodDistance, (v) =>
          ctx.history.run(
            new UpdateLayerCmd(
              layer.id,
              { settings: { ...layer.settings, lodDistance: Math.max(v, 100) } },
              "LOD distance",
            ),
          ), 100),
      ),
      el("p", { class: "hint" },
        "Transformed layers export as free blocks (off-grid) — the game grid can't hold them.",
      ),
    );
  };

  const renderAll = () => {
    renderList();
    renderSettings();
  };

  doc.events.on("layerAdded", renderAll);
  doc.events.on("layerRemoved", renderAll);
  doc.events.on("layerChanged", renderAll);
  doc.events.on("activeLayerChanged", renderAll);
  doc.events.on("placementAdded", renderList);
  doc.events.on("placementRemoved", renderList);
  doc.events.on("mapChanged", renderSettings);
  doc.events.on("reset", renderAll);
  renderAll();

  return el("div", { class: "layers split" },
    el("div", { class: "layers-top" },
      el("div", { class: "layer-actions" },
        el("button", {
          onclick: () => ctx.history.run(new AddLayerCmd(createLayer(`Layer ${doc.layers.length + 1}`))),
        }, "+ Add layer"),
      ),
      list,
    ),
    el("div", { class: "layers-bottom" },
      el("div", { class: "tabs" }, tabGlobal, tabLayer),
      settingsBody,
    ),
  );
}
