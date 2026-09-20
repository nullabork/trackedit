import type { EditorContext } from "@plugins/api";
import { AddLayerCmd, RemoveLayerCmd, ReplacePlacementCmd, UpdateLayerCmd } from "@core/commands";
import { Vector3 } from "three";
import type { GhostPath, Layer, Placement } from "@core/layer";
import { DEFAULT_ATTEMPT_OPACITY, createLayer, isPlacementVisible, lineHue } from "@core/layer";
import { splitGhostRuns } from "@core/ghostRuns";
import type { WaypointPass } from "@core/waypoints";
import { onPassesChanged, passesOf } from "@plugins/linePasses";
import { frameDebugSubject } from "@render/debugView";
import { formatRaceTime, reloadGhost, removeGhost, updateGhost } from "./ghostActions";
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
 *
 * Driving lines (ghosts) are rows of their layer too, in their own hue. A
 * line expands into the waypoints it passes — start, the checkpoints in
 * driving order, finish — and double-clicking one flies there. Clicking a
 * line turns the LAYER tab into LINE: its settings.
 */
export function createLayersPanel(ctx: EditorContext): { element: HTMLElement; actions: HTMLElement } {
  const doc = ctx.document;
  let renamingId: string | null = null;
  let tab: "global" | "layer" = "layer";
  /** The line whose settings show in place of the layer's (null = the active layer's). */
  let selectedLine: { layerId: string; key: string } | null = null;
  const expandedLines = new Set<string>(); // `${layerId}\n${key}`

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

  // --- block tree: layer > unique block > placement ---
  const expandedLayers = new Set<string>();
  const expandedGroups = new Set<string>(); // `${layerId}\n${block}`

  const expander = (open: boolean, title: string, onclick: () => void) => {
    const b = el("button", { class: "layer-btn layer-expander", title }, open ? "▾" : "▸");
    b.addEventListener("click", (e) => { e.stopPropagation(); onclick(); });
    return b;
  };

  /** Short label for a block name (custom items carry long paths). */
  const shortName = (block: string) => {
    const tail = block.split("\\").pop() ?? block;
    return tail.replace(/\.(Item|Block)\.gbx(_CustomBlock)?$/i, "");
  };

  const whereLabel = (p: Placement) =>
    p.kind === "block" ? `${p.coord[0]}, ${p.coord[1]}, ${p.coord[2]}` : `${p.pos.map((v) => Math.round(v)).join(", ")} m`;

  /** Show or hide a whole block group; individual overrides in it reset. */
  const setGroupVisible = (layer: Layer, block: string, visible: boolean) => {
    const hiddenBlocks = visible ? layer.hiddenBlocks.filter((b) => b !== block) : [...new Set([...layer.hiddenBlocks, block])];
    ctx.history.run(new UpdateLayerCmd(layer.id, { hiddenBlocks }, visible ? "Show block group" : "Hide block group"));
    for (const p of layer.placements.values()) {
      if (p.block !== block || p.visible === undefined) continue;
      const { visible: _drop, ...rest } = p;
      ctx.history.run(new ReplacePlacementCmd(layer.id, rest as Placement, "Reset placement visibility"));
    }
  };

  const setPlacementVisible = (layer: Layer, p: Placement, visible: boolean) => {
    const groupDefault = !layer.hiddenBlocks.includes(p.block);
    const { visible: _drop, ...rest } = p;
    const next = visible === groupDefault ? rest : { ...rest, visible };
    ctx.history.run(new ReplacePlacementCmd(layer.id, next as Placement, visible ? "Show placement" : "Hide placement"));
  };

  const focusPlacement = (layer: Layer, p: Placement) => {
    ctx.selection.set([{ layerId: layer.id, placementId: p.id }]);
    try {
      frameDebugSubject(ctx, { uid: p.id });
    } catch (err) {
      ctx.ui.setStatus(`Could not frame: ${err instanceof Error ? err.message : err}`);
    }
  };

  /** Row to scroll into view after the next render (find buttons). */
  let revealKey: string | null = null;

  const placementRow = (layer: Layer, p: Placement) => {
    const on = isPlacementVisible(layer, p);
    const selected = ctx.selection.has(p.id);
    const row = el("div", {
      class: `layer-row tree-row tree-placement${on ? "" : " hidden-entry"}${selected ? " selected" : ""}`,
      "data-key": `p:${p.id}`,
      "data-pid": p.id,
      title: "Click to select (Shift adds), double-click to frame in the viewport",
    },
      el("span", { class: "tree-spacer" }),
      iconBtn(on ? "eye" : "eye-off", on ? "Hide this one" : "Show this one", () => setPlacementVisible(layer, p, !on)),
      el("span", { class: "layer-name" }, whereLabel(p),
        el("span", { class: "layer-count" }, p.kind === "free" ? (p.isItem ? " item" : " free") : ` dir ${p.dir}`)),
    );
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const entry = { layerId: layer.id, placementId: p.id };
      if (e.shiftKey) ctx.selection.toggle(entry);
      else ctx.selection.set([entry]);
    });
    row.addEventListener("dblclick", (e) => { e.stopPropagation(); focusPlacement(layer, p); });
    return row;
  };

  const groupRows = (layer: Layer) => {
    const groups = new Map<string, Placement[]>();
    for (const p of layer.placements.values()) (groups.get(p.block) ?? groups.set(p.block, []).get(p.block)!).push(p);
    const rows: HTMLElement[] = [];
    for (const [block, ps] of [...groups].sort((a, b) => shortName(a[0]).localeCompare(shortName(b[0])))) {
      const key = `${layer.id}\n${block}`;
      const open = expandedGroups.has(key);
      const hidden = layer.hiddenBlocks.includes(block);
      const shown = ps.filter((p) => isPlacementVisible(layer, p)).length;
      // A group reads as selected when every one of its placements is.
      const selected = ps.length > 0 && ps.every((p) => ctx.selection.has(p.id));
      const row = el("div", { class: `layer-row tree-row tree-group${hidden ? " hidden-entry" : ""}${selected ? " selected" : ""}`, "data-key": `g:${key}`, "data-group": key },
        expander(open, open ? "Collapse" : "List every placement", () => { open ? expandedGroups.delete(key) : expandedGroups.add(key); renderList(); }),
        iconBtn(hidden ? "eye-off" : "eye", hidden ? "Show all of this block" : "Hide all of this block", () => setGroupVisible(layer, block, hidden)),
        el("span", { class: "layer-name", title: block }, shortName(block),
          el("span", { class: "layer-count" }, shown === ps.length ? ` ${ps.length}` : ` ${shown}/${ps.length}`)),
      );
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const entries = ps.map((p) => ({ layerId: layer.id, placementId: p.id }));
        if (e.shiftKey) {
          const have = new Set(ctx.selection.list.map((s) => s.placementId));
          ctx.selection.set([...ctx.selection.list, ...entries.filter((s) => !have.has(s.placementId))]);
        } else ctx.selection.set(entries);
      });
      rows.push(row);
      // Stable order (edits re-insert placements): by position.
      const keyOf = (p: Placement) => p.kind === "block" ? [p.coord[0], p.coord[1], p.coord[2]] : p.pos;
      const sorted = [...ps].sort((a, b) => { const ka = keyOf(a), kb = keyOf(b); return ka[0] - kb[0] || ka[2] - kb[2] || ka[1] - kb[1]; });
      if (open) for (const p of sorted) rows.push(placementRow(layer, p));
    }
    return rows;
  };

  // --- driving lines: layer > line > the waypoints it passes ---

  const lineOf = (sel: { layerId: string; key: string } | null): { layer: Layer; ghost: GhostPath; index: number } | null => {
    const layer = sel && doc.getLayer(sel.layerId);
    const index = layer ? layer.ghosts.findIndex((g) => g.key === sel!.key) : -1;
    return layer && index >= 0 ? { layer, ghost: layer.ghosts[index], index } : null;
  };

  /** Fly to where the line passes the waypoint, keeping the view's angle, and select the waypoint. */
  const focusPass = (pass: WaypointPass) => {
    ctx.renderer.ensureNear(pass.placementId);
    ctx.selection.set([{ layerId: pass.layerId, placementId: pass.placementId }]);
    const { yaw, pitch } = ctx.view.rig.getState();
    ctx.view.rig.lookAt(new Vector3(pass.pos[0], pass.pos[1], pass.pos[2]), 140, yaw, pitch);
    ctx.ui.setStatus(`${pass.label}${pass.timeMs !== undefined ? ` at ${formatRaceTime(pass.timeMs)}` : ""} — ${shortName(pass.block)}`);
  };

  const passRow = (pass: WaypointPass) => {
    const name = pass.kind === "checkpoint" ? `Checkpoint ${pass.number}` : pass.label;
    const row = el("div", {
      class: `layer-row tree-row line-pass${ctx.selection.has(pass.placementId) ? " selected" : ""}`,
      "data-pid": pass.placementId,
      title: `${name} — ${shortName(pass.block)}. Double-click to go there`,
    },
      el("span", { class: `pass-badge pass-${pass.kind}` }, pass.number === null ? pass.label[0] : String(pass.number)),
      el("span", { class: "layer-name" }, name),
      el("span", { class: "layer-count pass-time" }, pass.timeMs !== undefined ? formatRaceTime(pass.timeMs) : ""),
    );
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.selection.set([{ layerId: pass.layerId, placementId: pass.placementId }]);
    });
    row.addEventListener("dblclick", (e) => { e.stopPropagation(); focusPass(pass); });
    return row;
  };

  /**
   * Lines loaded before ghosts' checkpoint times were kept only have geometry
   * to go by (trigger zones are bigger than the models, so a few get missed):
   * fetch such a line again, once, the first time its waypoints are wanted.
   */
  const upgraded = new Set<string>();
  const upgradeLine = (layer: Layer, ghost: GhostPath) => {
    const key = `${layer.id}
${ghost.key}`;
    if (ghost.checkpoints?.length || upgraded.has(key)) return;
    upgraded.add(key);
    void reloadGhost(ctx, layer.id, ghost).then((msg) => ctx.ui.setStatus(msg));
  };

  const lineRows = (layer: Layer) => {
    const rows: HTMLElement[] = [];
    layer.ghosts.forEach((ghost, gi) => {
      const key = `${layer.id}\n${ghost.key}`;
      const open = expandedLines.has(key);
      const on = ghost.visible !== false;
      const selected = selectedLine?.layerId === layer.id && selectedLine.key === ghost.key;
      const swatch = el("span", { class: "line-swatch" });
      swatch.style.background = lineHue(gi);
      const row = el("div", { class: `layer-row tree-row line-row${on ? "" : " hidden-entry"}${selected ? " selected" : ""}`, "data-key": `l:${key}` },
        expander(open, open ? "Collapse" : "List the start, checkpoints and finish this line passes", () => { open ? expandedLines.delete(key) : expandedLines.add(key); renderList(); }),
        iconBtn(on ? "eye" : "eye-off", on ? "Hide line" : "Show line", () => updateGhost(ctx, layer.id, ghost.key, { visible: !on })),
        swatch,
        el("span", { class: "layer-name", title: ghost.label }, ghost.driver ?? ghost.label,
          el("span", { class: "layer-count" }, ghost.timeMs ? ` ${formatRaceTime(ghost.timeMs)}` : "")),
        iconBtn("x", "Unload line", () => removeGhost(ctx, layer.id, ghost.key)),
      );
      row.style.setProperty("--line-hue", lineHue(gi));
      row.addEventListener("click", () => {
        selectedLine = { layerId: layer.id, key: ghost.key };
        tab = "layer";
        renderAll();
      });
      rows.push(row);
      if (open || selected) upgradeLine(layer, ghost);
      if (!open) return;
      const passes = passesOf(ctx, layer, ghost);
      if (passes.length) rows.push(...passes.map(passRow));
      else rows.push(el("div", { class: "layer-row tree-row tree-placement hidden-entry" },
        el("span", { class: "tree-spacer" }), el("span", { class: "layer-name" }, "passes no start, checkpoint or finish")));
    });
    return rows;
  };

  const renderList = () => {
    // The rows are rebuilt (a click re-renders for its selection state):
    // keep the scroll where it was, or the second click of a double-click
    // lands on whatever row slid under the pointer.
    const scrollTop = list.scrollTop;
    clear(list);
    for (const layer of doc.layers) {
      const active = layer.id === doc.activeLayer.id;
      const open = expandedLayers.has(layer.id);
      const row = el("div", { class: `layer-row${active ? " active" : ""}` },
        expander(open, open ? "Collapse" : "List the blocks in this layer", () => { open ? expandedLayers.delete(layer.id) : expandedLayers.add(layer.id); renderList(); }),
        iconBtn(layer.visible ? "eye" : "eye-off", layer.visible ? "Hide layer" : "Show layer", () =>
          ctx.history.run(new UpdateLayerCmd(layer.id, { visible: !layer.visible }, "Toggle visibility")),
        ),
        nameCell(layer),
        iconBtn(layer.locked ? "lock" : "unlock", layer.locked ? "Unlock" : "Lock", () =>
          ctx.history.run(new UpdateLayerCmd(layer.id, { locked: !layer.locked }, "Toggle lock")),
        ),
        iconBtn("x", "Delete layer", () => deleteLayer(layer)),
      );
      row.addEventListener("click", () => {
        selectedLine = null;
        doc.setActiveLayer(layer.id);
        renderAll();
      });
      list.append(row);
      list.append(...lineRows(layer));
      if (open) list.append(...groupRows(layer));
    }
    list.scrollTop = scrollTop;
    if (revealKey) {
      const target = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(revealKey)}"]`);
      revealKey = null;
      target?.scrollIntoView({ block: "nearest" });
    }
  };

  /** The selected placement (first of the selection) and its layer. */
  const selectedPlacement = (): { layer: Layer; p: Placement } | null => {
    const entry = ctx.selection.list[0];
    const layer = entry && doc.getLayer(entry.layerId);
    const p = layer?.placements.get(entry.placementId);
    return layer && p ? { layer, p } : null;
  };

  /** Expand the tree down to the selected block's group (or the block itself) and highlight it. */
  const findSelected = (level: "group" | "placement") => {
    const hit = selectedPlacement();
    if (!hit) {
      ctx.ui.setStatus("Select a block in the viewport first.");
      return;
    }
    const { layer, p } = hit;
    const key = `${layer.id}\n${p.block}`;
    expandedLayers.add(layer.id);
    if (level === "group") {
      const all = [...layer.placements.values()].filter((q) => q.block === p.block);
      ctx.selection.set(all.map((q) => ({ layerId: layer.id, placementId: q.id })));
      revealKey = `g:${key}`;
    } else {
      expandedGroups.add(key);
      ctx.selection.set([{ layerId: layer.id, placementId: p.id }]);
      revealKey = `p:${p.id}`;
    }
    renderList();
  };

  const actions = el("span", { class: "panel-actions" },
    iconBtn("find-group", "Find the selected block's group in the list", () => findSelected("group")),
    iconBtn("find-block", "Find the selected block in the list", () => findSelected("placement")),
  );

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

  /** How see-through the attempts are. Dragging only restyles; the value is saved on release. */
  const attemptSlider = (layer: Layer, ghost: GhostPath) => {
    const value = Math.round((ghost.attemptOpacity ?? DEFAULT_ATTEMPT_OPACITY) * 100);
    const input = el("input", { type: "range", min: "5", max: "100", step: "5", value: String(value), "aria-label": "Attempt opacity" });
    const out = el("output", {}, `${value}%`);
    input.addEventListener("input", () => {
      out.textContent = `${input.value}%`;
      ctx.events.emit("attemptOpacityPreview", { layerId: layer.id, key: ghost.key, opacity: Number(input.value) / 100 });
    });
    input.addEventListener("change", () => updateGhost(ctx, layer.id, ghost.key, { attemptOpacity: Number(input.value) / 100 }));
    return el("label", { class: "line-slider", title: "How solid the attempts are drawn" }, el("span", {}, "Opacity"), input, out);
  };

  /** Settings of the selected driving line. */
  const renderLineSettings = (layer: Layer, ghost: GhostPath, index: number) => {
    const attempts = splitGhostRuns(ghost.path, ghost.times, ghost.checkpoints).attempts.length;
    const passes = passesOf(ctx, layer, ghost);
    const checkpoints = passes.filter((p) => p.number !== null).length;
    const swatch = el("span", { class: "line-swatch" });
    swatch.style.background = lineHue(index);
    settingsBody.append(
      el("h4", {}, swatch, ` ${ghost.label}`),
      el("p", { class: "hint" },
        `${ghost.source === "map" ? "The map's validation ghost" : ghost.source === "tmx" ? "TMX replay" : "Nadeo record"}` +
        `${ghost.timeMs ? ` · ${formatRaceTime(ghost.timeMs)}` : ""} · on layer ${layer.name}. ` +
        `Passes ${checkpoints} checkpoint${checkpoints === 1 ? "" : "s"}` +
        `${passes.some((p) => p.label === "Finish") ? " and the finish" : ", never reaches a finish"}.`),
      checkbox("Show checkpoint numbers beside the line", !!ghost.showNumbers, false,
        (v) => updateGhost(ctx, layer.id, ghost.key, { showNumbers: v }),
        "A tag at every start, checkpoint and finish the line passes, counted in driving order and drawn over the map so it can be found from anywhere"),
      checkbox("Show the line", ghost.visible !== false, false, (v) => updateGhost(ctx, layer.id, ghost.key, { visible: v })),
      checkbox(`Show attempts${attempts ? ` (${attempts})` : ""}`, !!ghost.showAttempts, !attempts,
        (v) => updateGhost(ctx, layer.id, ghost.key, { showAttempts: v }),
        attempts
          ? "Also draw the tries that ended in a respawn before the next checkpoint. The line itself is only what got the driver to the next checkpoint."
          : ghost.times && ghost.checkpoints?.length ? "This run has no failed tries: it never respawned." : "This line was saved without its timing; reload it to tell attempts apart."),
      ...(ghost.showAttempts && attempts ? [attemptSlider(layer, ghost)] : []),
      el("p", { class: "hint" },
        "Expand the line in the list for the waypoints it passes, in order; double-click one to go there. " +
        "A respawn onto a checkpoint is not counted again."),
      el("div", { class: "layer-actions" },
        el("button", { onclick: () => removeGhost(ctx, layer.id, ghost.key) }, "Unload line")),
    );
  };

  const renderSettings = () => {
    clear(settingsBody);
    const line = lineOf(selectedLine);
    if (!line) selectedLine = null;
    tabLayer.textContent = line ? "Line" : "Layer";

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

    if (line) return renderLineSettings(line.layer, line.ghost, line.index);

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
        el("label", {}, "Rotation step (deg)"),
        num(layer.settings.rotationStep, (v) =>
          ctx.history.run(
            new UpdateLayerCmd(
              layer.id,
              { settings: { ...layer.settings, rotationStep: Math.min(Math.max(v, 1), 180) } },
              "Rotation step",
            ),
          ), 15),
        el("div", { class: "hint" },
          "Snap for grid-constrained rotation of this layer and everything in it; unconstrained ignores it."),
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
  // Selection only changes how rows LOOK. Rebuilding them here would swap the
  // row under the pointer between the two clicks of a double-click.
  ctx.selection.events.on("changed", () => {
    for (const row of list.querySelectorAll<HTMLElement>("[data-pid]"))
      row.classList.toggle("selected", ctx.selection.has(row.dataset.pid!));
    for (const row of list.querySelectorAll<HTMLElement>("[data-group]")) {
      const [layerId, block] = row.dataset.group!.split("\n");
      const ps = [...(doc.getLayer(layerId)?.placements.values() ?? [])].filter((p) => p.block === block);
      row.classList.toggle("selected", ps.length > 0 && ps.every((p) => ctx.selection.has(p.id)));
    }
  });
  doc.events.on("mapChanged", renderSettings);
  doc.events.on("reset", renderAll);
  // Waypoint lists follow the map as it loads and changes — no collapsing and re-opening.
  onPassesChanged(ctx, () => { if (expandedLines.size || selectedLine) renderAll(); });
  renderAll();

  const element = el("div", { class: "layers split" },
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
  return { element, actions };
}
