import { describe, expect, it, vi } from "vitest";
import { MapDocument } from "@core/document";
import { SelectionModel } from "@core/selection";
import { ControlPreferences } from "@input/ControlScheme";
import type { EditorContext } from "@plugins/api";
import type { ToolPointerEvent } from "./Tool";
import { SelectTool } from "./SelectTool";

function fixture() {
  const document = new MapDocument();
  const selection = new SelectionModel();
  const controls = new ControlPreferences();
  const setStatus = vi.fn();
  for (const id of ["first", "second"])
    document.activeLayer.placements.set(id, {
      id, kind: "block", block: id, coord: [0, 0, 0], dir: 0,
    });
  const tool = new SelectTool({
    document, selection,
    renderer: { getObject: () => undefined },
    view: { rig: { controls }, onFrame: vi.fn() },
    ui: { setStatus },
  } as unknown as EditorContext);
  const click = (id: string | null, shiftKey = false) => tool.onPointerDown({
    native: { shiftKey },
    pick: id ? { layerId: document.activeLayer.id, placementId: id } : null,
  } as ToolPointerEvent);
  return { selection, controls, setStatus, tool, click };
}

describe("selection across control presets", () => {
  it.each(["trackedit", "blender", "plasticity"] as const)("preserves Shift-click toggling with %s shortcuts", preset => {
    const { selection, controls, setStatus, tool, click } = fixture();
    controls.set(preset);
    const translate = preset === "trackedit" ? "T" : "G";
    expect(tool.hint).toContain("Shift+click");
    expect(tool.hint).toContain(`${translate}/R`);
    click("first");
    click("second", true);
    expect(selection.list).toHaveLength(2);
    expect(setStatus).toHaveBeenLastCalledWith(`2 selected — ${translate} translate, R rotate, Del delete`);
    click("second", true);
    expect(selection.list.map(e => e.placementId)).toEqual(["first"]);
    expect(setStatus).toHaveBeenLastCalledWith(`Selected first — ${translate} translate, R rotate, Del delete`);
    click("first", true);
    expect(selection.isEmpty).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith("");
  });

  it("preserves selection on Shift-clicking empty space and replaces it on plain clicks", () => {
    const { selection, setStatus, click } = fixture();
    click("first");
    click(null, true);
    expect(selection.list.map(e => e.placementId)).toEqual(["first"]);
    click("second");
    expect(selection.list.map(e => e.placementId)).toEqual(["second"]);
    click(null);
    expect(selection.isEmpty).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith("");
  });
});
