import { describe, expect, it } from "vitest";
import {
  AddLayerCmd,
  AddPlacementCmd,
  CompositeCmd,
  History,
  RemoveLayerCmd,
  RemovePlacementCmd,
  ReplacePlacementCmd,
  UpdateLayerCmd,
} from "./commands";
import { MapDocument } from "./document";
import { createLayer, type BlockPlacement } from "./layer";

const block = (id: string, coord: [number, number, number] = [0, 8, 0]): BlockPlacement => ({
  id,
  kind: "block",
  block: "RoadTechStraight",
  coord,
  dir: 0,
});

describe("History with placement commands", () => {
  it("run/undo/redo roundtrips a placement", () => {
    const doc = new MapDocument();
    const history = new History(doc);
    const layerId = doc.activeLayer.id;

    history.run(new AddPlacementCmd(layerId, block("p1")));
    expect(doc.activeLayer.placements.has("p1")).toBe(true);

    history.undo();
    expect(doc.activeLayer.placements.has("p1")).toBe(false);

    history.redo();
    expect(doc.activeLayer.placements.has("p1")).toBe(true);
  });

  it("restores displaced placements on undo (overwriting a cell)", () => {
    const doc = new MapDocument();
    const history = new History(doc);
    const layerId = doc.activeLayer.id;
    const old = block("old", [3, 8, 3]);

    history.run(new AddPlacementCmd(layerId, old));
    history.run(new AddPlacementCmd(layerId, block("new", [3, 8, 3]), [old]));
    expect(doc.activeLayer.placements.has("old")).toBe(false);
    expect(doc.activeLayer.placements.has("new")).toBe(true);

    history.undo();
    expect(doc.activeLayer.placements.has("old")).toBe(true);
    expect(doc.activeLayer.placements.has("new")).toBe(false);
  });

  it("a new edit clears the redo stack", () => {
    const doc = new MapDocument();
    const history = new History(doc);
    const layerId = doc.activeLayer.id;

    history.run(new AddPlacementCmd(layerId, block("p1")));
    history.undo();
    history.run(new AddPlacementCmd(layerId, block("p2", [1, 8, 1])));
    history.redo(); // nothing to redo
    expect(doc.activeLayer.placements.has("p1")).toBe(false);
    expect(doc.activeLayer.placements.has("p2")).toBe(true);
  });

  it("CompositeCmd undoes as one step, in reverse order", () => {
    const doc = new MapDocument();
    const history = new History(doc);
    const layerId = doc.activeLayer.id;

    history.run(new CompositeCmd(
      [new AddPlacementCmd(layerId, block("a", [0, 8, 0])),
       new AddPlacementCmd(layerId, block("b", [1, 8, 0]))],
      "Paint stroke",
    ));
    expect(doc.activeLayer.placements.size).toBe(2);
    history.undo();
    expect(doc.activeLayer.placements.size).toBe(0);
  });

  it("ReplacePlacementCmd keeps the id but swaps the data", () => {
    const doc = new MapDocument();
    const history = new History(doc);
    const layerId = doc.activeLayer.id;

    history.run(new AddPlacementCmd(layerId, block("p1", [0, 8, 0])));
    history.run(new ReplacePlacementCmd(layerId, { ...block("p1", [5, 8, 5]), dir: 2 }));
    let placed = doc.activeLayer.placements.get("p1") as BlockPlacement;
    expect(placed.coord).toEqual([5, 8, 5]);
    expect(placed.dir).toBe(2);

    history.undo();
    placed = doc.activeLayer.placements.get("p1") as BlockPlacement;
    expect(placed.coord).toEqual([0, 8, 0]);
    expect(placed.dir).toBe(0);
  });

  it("RemovePlacementCmd undo restores the exact placement", () => {
    const doc = new MapDocument();
    const history = new History(doc);
    const layerId = doc.activeLayer.id;
    const original = block("p1", [2, 8, 2]);

    history.run(new AddPlacementCmd(layerId, original));
    history.run(new RemovePlacementCmd(layerId, "p1"));
    expect(doc.activeLayer.placements.size).toBe(0);
    history.undo();
    expect(doc.activeLayer.placements.get("p1")).toEqual(original);
  });
});

describe("layer commands", () => {
  it("add/remove layer roundtrips and preserves order on undo", () => {
    const doc = new MapDocument();
    const history = new History(doc);
    const extra = createLayer("Extra");

    history.run(new AddLayerCmd(extra));
    expect(doc.layers.length).toBe(2);
    expect(doc.activeLayer.id).toBe(extra.id); // add activates

    history.run(new RemoveLayerCmd(doc.layers[0].id));
    expect(doc.layers.length).toBe(1);
    history.undo();
    expect(doc.layers[1].id).toBe(extra.id); // restored at its old index
  });

  it("refuses to remove the last layer", () => {
    const doc = new MapDocument();
    expect(doc.mutRemoveLayer(doc.activeLayer.id)).toBeUndefined();
    expect(doc.layers.length).toBe(1);
  });

  it("UpdateLayerCmd undo restores previous values of touched keys only", () => {
    const doc = new MapDocument();
    const history = new History(doc);
    const layer = doc.activeLayer;

    history.run(new UpdateLayerCmd(layer.id, { name: "Renamed", locked: true }));
    expect(layer.name).toBe("Renamed");
    expect(layer.locked).toBe(true);
    history.undo();
    expect(layer.name).toBe("Base");
    expect(layer.locked).toBe(false);
  });
});

describe("sub-base clamp in the document", () => {
  it("clamps layer transforms when the layer opts in", () => {
    const doc = new MapDocument();
    doc.mutUpdateLayer(doc.activeLayer.id, { clampToBase: true });
    doc.mutUpdateLayer(doc.activeLayer.id, {
      transform: { translate: [0, -50, 0], rotDeg: [0, 0, 0] },
    });
    expect(doc.activeLayer.transform.translate[1]).toBe(0);
  });

  it("does not clamp without the flag", () => {
    const doc = new MapDocument();
    doc.mutUpdateLayer(doc.activeLayer.id, {
      transform: { translate: [0, -50, 0], rotDeg: [0, 0, 0] },
    });
    expect(doc.activeLayer.transform.translate[1]).toBe(-50);
  });

  it("global override clamps every layer when switched on", () => {
    const doc = new MapDocument();
    doc.mutUpdateLayer(doc.activeLayer.id, {
      transform: { translate: [0, -50, 0], rotDeg: [0, 0, 0] },
    });
    doc.setGlobalClampToBase(true);
    expect(doc.activeLayer.transform.translate[1]).toBe(0);
  });
});

describe("document reset", () => {
  it("replaces content and per-map meta, clearing mods by default", () => {
    const doc = new MapDocument();
    doc.modUrl = "https://example.com/old.zip";
    doc.activeMod = "old-mod";
    doc.colorPalette = "Purple";

    const layer = createLayer("Imported");
    doc.reset([layer], { name: "My map", decoration: "NoStadium48x48Sunset" });

    expect(doc.name).toBe("My map");
    expect(doc.decorationBase).toBe("NoStadium48x48");
    expect(doc.mood).toBe("Sunset");
    expect(doc.activeLayer.id).toBe(layer.id);
    expect(doc.modUrl).toBeNull();
    expect(doc.activeMod).toBeNull();
    expect(doc.colorPalette).toBe("Classic");
  });

  it("always keeps at least one layer", () => {
    const doc = new MapDocument();
    doc.reset([]);
    expect(doc.layers.length).toBe(1);
  });
});
