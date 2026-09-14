import { describe, expect, it } from "vitest";
import { exportDump, ghostToLayer, importDump } from "./trackoJson";
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
    expect(layers[0].ghosts[0]?.path).toHaveLength(3);
    expect(layers[0].ghosts[0]?.path[1]).toEqual([48, 72, 16]);
  });

  it("survives a save/load round trip on the layer", () => {
    const doc = new MapDocument();
    const { layers } = importDump({ blocks: [], items: [], ghost }, 0);
    doc.reset(layers, { name: "t" });
    const rec = serializeDoc(doc);
    expect(rec.layers[0].ghosts?.[0]?.path).toEqual(ghost.path);
    const back = toLayers(rec);
    expect(back[0].ghosts[0]?.timeMs).toBe(61234);
    expect(back[0].ghosts[0]?.path).toEqual(ghost.path);
  });

  it("labels a Nadeo record ghost and keeps the account id", () => {
    const g = ghostToLayer({ ...ghost, source: "nadeo", nickname: "Racer", accountId: "acc-1" }, 0);
    expect(g.source).toBe("nadeo");
    expect(g.accountId).toBe("acc-1");
    expect(g.label).toBe("Nadeo record by Racer");
  });

  it("upgrades records saved with a single ghost to a keyed list", () => {
    const doc = new MapDocument();
    const { layers } = importDump({ blocks: [], items: [], ghost }, 0);
    doc.reset(layers, { name: "t" });
    const rec = serializeDoc(doc);
    const legacy = { ...rec, layers: rec.layers.map((l) => ({ ...l, ghost: l.ghosts?.[0], ghosts: undefined })) };
    const back = toLayers(legacy);
    expect(back[0].ghosts).toHaveLength(1);
    expect(back[0].ghosts[0].key).toBe("map");
  });

  it("layers without a ghost stay ghost-free", () => {
    const { layers } = importDump({ blocks: [], items: [] });
    expect(layers[0].ghosts).toEqual([]);
  });
});

describe("item pivots", () => {
  const item = {
    name: "Custom\\HalfBanked.Item.Gbx",
    absPos: [656, 48, 944] as [number, number, number],
    yawPitchRoll: [Math.PI / 2, Math.PI, 0] as [number, number, number],
    pivotPos: [-16, -6, -16] as [number, number, number],
  };

  it("keeps a custom item's pivot so it rotates about the game's anchor", () => {
    const { layers } = importDump({ blocks: [], items: [item] }, 8);
    const p = [...layers[0].placements.values()][0];
    expect(p.kind).toBe("free");
    if (p.kind !== "free") return;
    expect(p.pos).toEqual([656, 48 + 64, 944]);
    expect(p.pivot).toEqual([-16, -6, -16]);
    expect(p.meta?.pivotPos).toBeUndefined();
  });

  it("drops a zero pivot (the origin is the anchor)", () => {
    const { layers } = importDump({ blocks: [], items: [{ ...item, pivotPos: [0, 0, 0] }] }, 8);
    const p = [...layers[0].placements.values()][0];
    expect(p.kind === "free" && p.pivot).toBeUndefined();
  });

  it("writes the pivot back unchanged, even under a layer transform", () => {
    const doc = new MapDocument();
    const { layers } = importDump({ blocks: [], items: [item] }, 8);
    layers[0].transform = { translate: [32, 0, 0], rotDeg: [0, 90, 0] };
    doc.reset(layers, { name: "t" });
    const out = exportDump(doc, 8);
    expect(out.items).toHaveLength(1);
    expect(out.items?.[0].pivotPos).toEqual([-16, -6, -16]);
    expect(out.items?.[0].absPos?.[1]).toBe(48);
  });
});
