import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Group, PerspectiveCamera } from "three";
import { CameraRig } from "@render/CameraRig";
import { ToolManager } from "@tools/ToolManager";
import { MapDocument } from "@core/document";
import { History } from "@core/commands";
import { InputEngine } from "./InputEngine";
import { ControlPreferences } from "./ControlScheme";
import type { EditorContext } from "@plugins/api";
import type { SceneView } from "@render/SceneView";
import type { DocumentRenderer } from "@render/DocumentRenderer";

class ElementStub extends EventTarget {
  closest() { return null; }
  setPointerCapture() {}
  requestPointerLock = vi.fn();
}

function fire(target: EventTarget, type: string, values: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { key: "", code: "", button: 0, pointerId: 1, movementX: 0, movementY: 0,
    altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...values });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("HTMLElement", ElementStub);
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    querySelector: () => null, activeElement: null, pointerLockElement: null, exitPointerLock: vi.fn(),
  }));
});
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const canvas = new ElementStub();
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera, canvas as unknown as HTMLElement);
  const doc = new MapDocument();
  const renderer = { getLayerGroup: () => new Group() } as unknown as DocumentRenderer;
  const view = { canvas, camera, rig } as unknown as SceneView;
  const manager = new ToolManager(doc, view, renderer);
  const tool = { id: "select", label: "Select", onRightDown: vi.fn(), onPointerMove: vi.fn() };
  manager.register(tool);
  manager.setActive("select");
  return { canvas, rig, manager, tool, doc, renderer, view };
}

describe("control presets", () => {
  it("restores a valid preference and ignores corrupt or unavailable storage", () => {
    const prefs = new ControlPreferences();
    expect(prefs.id).toBe("trackedit");
    prefs.set("plasticity");
    expect(new ControlPreferences().id).toBe("plasticity");
    localStorage.setItem("trackedit.controlScheme", "__proto__");
    expect(new ControlPreferences().id).toBe("trackedit");
    vi.stubGlobal("localStorage", { getItem() { throw Error(); }, setItem() { throw Error(); } });
    const unavailable = new ControlPreferences();
    expect(() => unavailable.set("blender")).not.toThrow();
    expect(unavailable.id).toBe("blender");
  });

  it.each(["blender", "plasticity"] as const)("%s gives the wheel to zoom and Alt+wheel to height", id => {
    const { rig, canvas, manager } = fixture();
    rig.controls.set(id);
    const distance = rig.focusDistance;
    const level = manager.buildLevel;
    fire(canvas, "wheel", { deltaY: -100 });
    expect(rig.focusDistance).toBeLessThan(distance);
    expect(manager.buildLevel).toBe(level);
    const zoomed = rig.getState();
    fire(canvas, "wheel", { deltaY: -100, altKey: true });
    expect(manager.buildLevel).toBe(level + 1);
    expect(rig.getState()).toEqual(zoomed);
  });

  it("keeps Trackedit wheel height and camera dolly separate", () => {
    const { rig, canvas, manager } = fixture();
    const initial = rig.getState();
    const level = manager.buildLevel;
    fire(canvas, "wheel", { deltaY: -100 });
    expect(manager.buildLevel).toBe(level + 1);
    expect(rig.getState()).toEqual(initial);
    fire(canvas, "wheel", { deltaY: -100, altKey: true });
    expect(manager.buildLevel).toBe(level + 1);
    expect(rig.getState().pos).not.toEqual(initial.pos);
  });

  it("pans with Plasticity RMB without invoking the tool or flying", () => {
    const { rig, canvas, tool } = fixture();
    rig.controls.set("plasticity");
    const initial = rig.getState();
    fire(canvas, "pointerdown", { button: 2 });
    fire(canvas, "pointermove", { button: 2, movementX: 20 });
    fire(canvas, "pointerup", { button: 2 });
    expect(rig.getState().pos).not.toEqual(initial.pos);
    expect(rig.getState().yaw).toBe(initial.yaw);
    expect(rig.isFlying).toBe(false);
    expect(tool.onRightDown).not.toHaveBeenCalled();
    expect(tool.onPointerMove).not.toHaveBeenCalled();
  });

  it("only moves with WASD outside fly mode in Trackedit", () => {
    const { rig } = fixture();
    rig.controls.set("blender");
    const initial = rig.getState();
    fire(window, "keydown", { key: "w", code: "KeyW" });
    rig.update(1);
    expect(rig.getState()).toEqual(initial);
    rig.controls.set("trackedit");
    fire(window, "keydown", { key: "w", code: "KeyW" });
    rig.update(1);
    expect(rig.getState().pos).not.toEqual(initial.pos);
  });

  it("switching presets stops a drag and held movement keys", () => {
    const { rig, canvas } = fixture();
    fire(canvas, "pointerdown", { button: 1 });
    fire(window, "keydown", { key: "w", code: "KeyW" });
    rig.controls.set("blender");
    const initial = rig.getState();
    rig.update(1);
    expect(rig.isNavigating).toBe(false);
    expect(rig.getState()).toEqual(initial);
  });

  it.each(["blender", "plasticity"] as const)("%s supports orbit and Ctrl+MMB zoom without editing", id => {
    const { rig, canvas, tool } = fixture();
    rig.controls.set(id);
    const initial = rig.getState();
    fire(canvas, "pointerdown", { button: 1 });
    fire(canvas, "pointermove", { movementX: 20 });
    fire(canvas, "pointerup", { button: 1 });
    expect(rig.getState().yaw).not.toBe(initial.yaw);
    expect(rig.focusDistance).toBe(initial.distance);
    fire(canvas, "pointerdown", { button: 1, ctrlKey: true });
    fire(canvas, "pointermove", { movementY: -20 });
    fire(canvas, "pointerup", { button: 1 });
    expect(rig.focusDistance).toBeLessThan(initial.distance);
    expect(tool.onPointerMove).not.toHaveBeenCalled();
  });

  it("ignores editor shortcuts and held movement while a dialog is open", () => {
    const { rig, manager } = fixture();
    const handler = vi.fn();
    manager.setInterceptor({ handleKey: handler, handlePointerDown: () => false, handlePointerMove: () => false });
    fire(window, "keydown", { key: "w", code: "KeyW" });
    vi.spyOn(document, "querySelector").mockReturnValue({} as Element);
    const initial = rig.getState();
    fire(window, "keydown", { key: "g", code: "KeyG" });
    rig.update(1);
    expect(rig.getState()).toEqual(initial);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(["blender", "plasticity"] as const)("%s uses its modal right-click behavior", id => {
    const { rig, manager, doc, renderer, view } = fixture();
    rig.controls.set(id);
    const history = new History(doc);
    const ctx = { view, tools: manager, document: doc, renderer, history, selection: { list: [] },
      ui: { setHud: vi.fn(), setStatus: vi.fn() } } as unknown as EditorContext;
    const engine = new InputEngine(ctx);
    for (const key of ["g", "x", "1", "0"])
      engine.handleKey({ key } as KeyboardEvent);
    engine.handlePointerDown({ button: 2 } as PointerEvent);
    expect(engine.modal).toBe(false);
    expect(doc.activeLayer.transform.translate[0]).toBe(id === "plasticity" ? 10 : 0);
    if (id === "plasticity") {
      history.undo();
      expect(doc.activeLayer.transform.translate[0]).toBe(0);
    }
  });

  it("switches transform keys, preserves modifier shortcuts, and cancels previews on preset changes", () => {
    const { rig, manager, doc, renderer, view } = fixture();
    const hud = vi.fn();
    const ctx = { view, tools: manager, document: doc, renderer, selection: { list: [] },
      ui: { setHud: hud, setStatus: vi.fn() } } as unknown as EditorContext;
    const engine = new InputEngine(ctx);
    const key = (k: string, extra = {}) => ({ key: k, ...extra }) as KeyboardEvent;
    expect(engine.handleKey(key("g"))).toBe(false);
    rig.controls.set("blender");
    expect(engine.handleKey(key("g", { ctrlKey: true }))).toBe(false);
    expect(engine.handleKey(key("t"))).toBe(false);
    expect(engine.handleKey(key("g"))).toBe(true);
    expect(engine.modal).toBe(true);
    expect(rig.suspended).toBe(true);
    expect(hud.mock.lastCall?.[0][0][0]).toContain("G");
    rig.controls.set("plasticity");
    expect(engine.modal).toBe(false);
    expect(rig.suspended).toBe(false);
  });
});
