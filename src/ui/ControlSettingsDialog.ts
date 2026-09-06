import { CONTROL_SCHEMES, isControlScheme } from "@input/ControlScheme";
import type { EditorContext } from "@plugins/api";
import { clear, el } from "./dom";
import { openDialog } from "./dialog";

export function openControlSettings(ctx: EditorContext): void {
  const controls = ctx.view.rig.controls;
  const select = el("select", { class: "input", id: "control-scheme" },
    ...Object.entries(CONTROL_SCHEMES).map(([id, scheme]) => el("option", { value: id }, scheme.label)),
  );
  select.value = controls.id;
  const reference = el("table", { class: "control-reference" });
  const render = () => {
    const s = controls.scheme;
    const rows = [
      ["Orbit", "MMB drag"], ["Pan", s.pan], ["Zoom", s.zoom],
      ["Build height", s.height], ["Move / rotate", `${s.translate.toUpperCase()} / R`],
      ["Frame selection", s.frame], ["Fly mode", s.fly],
      ["WASD + Space/C", s.alwaysMove ? "Move camera anytime" : "Move camera in fly mode"],
      ["Confirm transform", controls.id === "plasticity" ? "Enter / left or right click" : "Enter / left click"],
      ["Cancel transform", controls.id === "plasticity" ? "Esc" : "Esc / right click"],
    ];
    clear(reference);
    reference.append(el("tbody", {}, ...rows.map(([action, keys]) =>
      el("tr", {}, el("th", { scope: "row" }, action), el("td", {}, keys)),
    )));
  };
  select.addEventListener("change", () => {
    if (!isControlScheme(select.value)) return;
    controls.set(select.value);
    render();
    ctx.ui.setStatus(ctx.tools.activeTool?.hint ?? `${controls.scheme.label} controls enabled`);
  });
  render();
  openDialog({ title: "Controls", width: 430, content: el("div", {},
    el("div", { class: "field" }, el("label", { for: "control-scheme" }, "Control scheme"), select),
    el("p", { class: "hint" }, "Applies immediately and is remembered in this browser."),
    reference,
    el("p", { class: "hint" }, "Presets cover navigation and supported transforms. P: place/grid ↔ free; E: select; Del: delete; Ctrl/Cmd+Z: undo; Ctrl/Cmd+Shift+Z: redo. Scaling and mesh-editing commands are not supported."),
  ) });
  select.focus();
}
