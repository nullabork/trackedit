import { describe, expect, it } from "vitest";
import { ghostToLayer, importDump } from "./trackoJson";
import { serializeDoc, toLayers } from "./mapStore";
import { MapDocument } from "@core/document";

const ghost = {
  source: "map" as const,
  nickname: "Author",
  raceTimeMs: 61234,
  path: [[16, 8, 16], [48, 8, 16], [80, 12, 48]] as [number, number, number][],
  times: [0, 500, 1000],
};

describe("ghost paths", () => {
  it("lifts a ghost path by the decoration's vertical origin like free positions", () => {
    const g = ghostToLayer(ghost, 8);
    expect(g.path[0]).toEqual([16, 8 + 64, 16]);
    expect(g.path[2]).toEqual([80, 12 + 64, 48]);
    expect(g.times).toEqual([0, 500, 1000]);
    expect(g.label).toContain("Author");
    expect(g.source).toBe("map");
  });

  it("attaches a map's validation ghost to the imported layer", () => {
    const { layers } = importDump({ blocks: [], items: [], ghost }, 8);
    expect(layers[0].ghost?.path).toHaveLength(3);
    expect(layers[0].ghost?.path[1]).toEqual([48, 72, 16]);
  });

  it("survives a save/load round trip on the layer", () => {
    const doc = new MapDocument();
    const { layers } = importDump({ blocks: [], items: [], ghost }, 0);
    doc.reset(layers, { name: "t" });
    const rec = serializeDoc(doc);
    expect(rec.layers[0].ghost?.path).toEqual(ghost.path);
    const back = toLayers(rec);
    expect(back[0].ghost?.timeMs).toBe(61234);
    expect(back[0].ghost?.path).toEqual(ghost.path);
  });

  it("layers without a ghost stay ghost-free", () => {
    const { layers } = importDump({ blocks: [], items: [] });
    expect(layers[0].ghost).toBeUndefined();
  });
});
