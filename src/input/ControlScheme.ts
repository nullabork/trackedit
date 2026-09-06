import { Emitter } from "@core/events";

export type ControlSchemeId = "trackedit" | "blender" | "plasticity";
export type DragAction = "orbit" | "pan" | "zoom" | "fly";
type Modifiers = { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

export const CONTROL_SCHEMES = {
  trackedit: { label: "Trackedit", translate: "t", pan: "Shift + MMB", zoom: "Alt + wheel",
    height: "Wheel", fly: "F or hold RMB", frame: "Frame button", alwaysMove: true },
  blender: { label: "Blender", translate: "g", pan: "Shift + MMB", zoom: "Wheel / Ctrl + MMB",
    height: "Alt + wheel", fly: "Shift + `", frame: "Numpad .", alwaysMove: false },
  plasticity: { label: "Plasticity", translate: "g", pan: "RMB / Shift + MMB", zoom: "Wheel / Ctrl + MMB",
    height: "Alt + wheel", fly: "Shift + `", frame: "/", alwaysMove: false },
} as const;

const KEY = "trackedit.controlScheme";
export function isControlScheme(value: unknown): value is ControlSchemeId {
  return typeof value === "string" && Object.hasOwn(CONTROL_SCHEMES, value);
}

export class ControlPreferences {
  readonly events = new Emitter<{ changed: ControlSchemeId }>();
  private current: ControlSchemeId = "trackedit";

  constructor() {
    try {
      const saved = localStorage.getItem(KEY);
      if (isControlScheme(saved)) this.current = saved;
    } catch { /* Browser storage is optional. */ }
  }

  get id(): ControlSchemeId { return this.current; }
  get scheme() { return CONTROL_SCHEMES[this.current]; }

  set(id: ControlSchemeId): void {
    if (!isControlScheme(id) || id === this.current) return;
    this.current = id;
    try { localStorage.setItem(KEY, id); } catch { /* Apply even without storage. */ }
    this.events.emit("changed", id);
  }
}

export function dragAction(id: ControlSchemeId, e: Modifiers & { button: number }): DragAction | null {
  if (e.button === 1) {
    if (id !== "trackedit" && e.ctrlKey) return "zoom";
    return e.shiftKey ? "pan" : "orbit";
  }
  if (e.button === 2) return id === "trackedit" ? "fly" : id === "plasticity" ? "pan" : null;
  return null;
}

export function wheelAction(id: ControlSchemeId, e: Modifiers): "height" | "zoom" | "elevate" | "dolly" {
  if (id === "trackedit") return e.ctrlKey ? "elevate" : e.altKey ? "dolly" : "height";
  return e.altKey ? "height" : "zoom";
}

export function flyShortcut(id: ControlSchemeId, e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return id === "trackedit" ? e.key.toLowerCase() === "f" : e.shiftKey && e.code === "Backquote";
}

/** Global editor shortcuts must leave forms and open dialogs alone. */
export function blocksEditorInput(target: EventTarget | null): boolean {
  return !!document.querySelector(".dialog-overlay") ||
    (target instanceof HTMLElement && !!target.closest("input, select, textarea, [contenteditable]:not([contenteditable=false])"));
}
