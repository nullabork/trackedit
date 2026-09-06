import { describe, expect, it } from "vitest";
import { MapDocument } from "@core/document";
import { selectedLiveBlock } from "./liveBlock";

describe("selected live block", () => {
  it("preserves grid coordinates and direction without applying a free-position offset", () => {
    const doc = new MapDocument();
    const layer = doc.activeLayer;
    layer.placements.set("block", { id: "block", kind: "block", block: "RoadTechStraight", coord: [2, 8, 3], dir: 3, meta: { isGround: true } });
    expect(selectedLiveBlock(doc, [{ layerId: layer.id, placementId: "block" }])).toEqual({ name: "RoadTechStraight", coord: [2, 8, 3], dir: 3, isGround: true });
    layer.transform.translate = [32, 0, 0];
    expect(() => selectedLiveBlock(doc, [{ layerId: layer.id, placementId: "block" }])).toThrow("translation or rotation");
  });

  it("rejects missing, multiple, and free placements", () => {
    const doc = new MapDocument();
    const entry = { layerId: doc.activeLayer.id, placementId: "item" };
    expect(() => selectedLiveBlock(doc, [])).toThrow("exactly one");
    expect(() => selectedLiveBlock(doc, [entry, entry])).toThrow("exactly one");
    expect(() => selectedLiveBlock(doc, [entry])).toThrow("no longer exists");
    doc.activeLayer.placements.set("item", { id: "item", kind: "free", block: "Item", pos: [0, 0, 0], rot: [0, 0, 0], isItem: true });
    expect(() => selectedLiveBlock(doc, [entry])).toThrow("grid blocks only");
  });
});
