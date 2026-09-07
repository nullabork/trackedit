import { CONTROL_SCHEMES, isControlScheme } from "@input/ControlScheme";
import type { EditorContext } from "@plugins/api";
import { clear, el } from "./dom";
import { openDialog } from "./dialog";

/**
 * Controls: scheme picker + reference on the left, the key sequences
 * (docs/SPEC-sequence-shortcuts.md) on the right. The chains work the same
 * in every scheme; only the translate key changes.
 */
export function openControlSettings(ctx: EditorContext): void {
  const controls = ctx.view.rig.controls;
  const select = el("select", { class: "input", id: "control-scheme" },
    ...Object.entries(CONTROL_SCHEMES).map(([id, scheme]) => el("option", { value: id }, scheme.label)),
  );
  select.value = controls.id;
  const reference = el("table", { class: "control-reference" });
  const sequences = el("div", { class: "control-sequences" });
  const render = () => {
    const s = controls.scheme;
    const T = s.translate.toUpperCase();
    const confirm = controls.id === "plasticity" ? "Enter / left or right click" : "Enter / left click";
    const cancel = controls.id === "plasticity" ? "Esc" : "Esc / right click";
    const rows = [
      ["Orbit", "MMB drag"], ["Pan", s.pan], ["Zoom", s.zoom],
      ["Build height", s.height], ["Move / rotate", `${T} / R`],
      ["Frame selection", s.frame], ["Fly mode", s.fly],
      ["WASD + Space/C", s.alwaysMove ? "Move camera anytime" : "Move camera in fly mode"],
      ["Confirm transform", confirm],
      ["Cancel transform", cancel],
    ];
    clear(reference);
    reference.append(el("tbody", {}, ...rows.map(([action, keys]) =>
      el("tr", {}, el("th", { scope: "row" }, action), el("td", {}, keys)),
    )));

    const chains: [string, string][] = [
      [`${T}`, "move the selection freely with the mouse"],
      [`${T} X`, "move along one axis (X, Y or Z); the mouse drives it"],
      [`${T} X Y`, "move in the plane of two axes"],
      [`${T} X 12`, "type a distance: exactly 12 m along X (keep typing to edit; 1.5 allows off-grid)"],
      [`${T} L X 12`, "L retargets the layer: move the selection's layer 12 m along its own X"],
      ["R X", "rotate about the selection's own X axis with the mouse (Y snaps grid blocks to quarter turns)"],
      ["R X 99", "type an angle: exactly 99° about X"],
      ["R L X 99", "rotate the layer 99° about its X axis (tilts the whole plane in place)"],
      ["-", "negate the typed number; Backspace removes the last digit"],
      ["C X / C L X", "slide the camera along a world axis / the active layer's axis"],
      [confirm, "confirm (one undoable step)"],
      [cancel, "cancel and restore"],
    ];
    clear(sequences);
    sequences.append(
      el("div", { class: "field" }, el("label", {}, "Key sequences")),
      el("p", { class: "hint" },
        `Press the keys one after another, no modifiers. ${T} starts a move, R a rotation, C a camera slide. ` +
        "Axis letters constrain it, L switches to the layer, digits switch from mouse to typed input. " +
        "Pitching or rolling a grid block, or typing a non-quarter yaw, converts it to a free block on confirm."),
      el("table", { class: "control-reference" }, el("tbody", {}, ...chains.map(([keys, what]) =>
        el("tr", {}, el("th", { scope: "row" }, el("kbd", {}, keys)), el("td", {}, what)),
      ))),
    );
  };
  select.addEventListener("change", () => {
    if (!isControlScheme(select.value)) return;
    controls.set(select.value);
    render();
    ctx.ui.setStatus(ctx.tools.activeTool?.hint ?? `${controls.scheme.label} controls enabled`);
  });
  render();
  openDialog({ title: "Controls", width: 860, content: el("div", { class: "controls-columns" },
    el("div", { class: "controls-col" },
      el("div", { class: "field" }, el("label", { for: "control-scheme" }, "Control scheme"), select),
      el("p", { class: "hint" }, "Applies immediately and is remembered in this browser."),
      reference,
      el("p", { class: "hint" }, "Presets cover navigation and supported transforms. P: grid constrained ↔ unconstrained placement; E: select; Del: delete; Ctrl/Cmd+Z: undo; Ctrl/Cmd+Shift+Z: redo. Scaling and mesh-editing commands are not supported."),
    ),
    el("div", { class: "controls-col" }, sequences),
  ) });
  select.focus();
}
