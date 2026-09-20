import { describe, expect, it } from "vitest";
import { clampTransformToBase, createLayer, isIdentityTransform, type LayerTransform } from "./layer";

const SIZE = 48 * 32; // 48-cell world edge in metres

describe("clampTransformToBase", () => {
  it("leaves transforms at or above the base untouched (same object)", () => {
    const t: LayerTransform = { translate: [10, 5, -20], rotDeg: [0, 0, 0] };
    expect(clampTransformToBase(t, SIZE, SIZE)).toBe(t);
  });

  it("stops plain downward translation below the base", () => {
    const t: LayerTransform = { translate: [0, -100, 0], rotDeg: [0, 0, 0] };
    expect(clampTransformToBase(t, SIZE, SIZE).translate[1]).toBe(0);
  });

  it("auto-lifts a tilted plane so its lowest corner sits at base level", () => {
    // Rolling about Z dips the far-X edge by sin(25°) * width.
    const t: LayerTransform = { translate: [0, 0, 0], rotDeg: [0, 0, -25] };
    const clamped = clampTransformToBase(t, SIZE, SIZE);
    expect(clamped.rotDeg).toEqual([0, 0, -25]); // keeps rotating
    expect(clamped.translate[1]).toBeCloseTo(SIZE * Math.sin((25 * Math.PI) / 180), 6);
  });

  it("does not lift when the existing translation already compensates", () => {
    const lift = SIZE * Math.sin((25 * Math.PI) / 180) + 1;
    const t: LayerTransform = { translate: [0, lift, 0], rotDeg: [0, 0, -25] };
    expect(clampTransformToBase(t, SIZE, SIZE)).toBe(t);
  });
});

describe("createLayer", () => {
  it("starts identity, visible, unlocked, with the native grid", () => {
    const layer = createLayer("Test");
    expect(isIdentityTransform(layer.transform)).toBe(true);
    expect(layer.visible).toBe(true);
    expect(layer.locked).toBe(false);
    expect(layer.settings.gridStep).toEqual([32, 8, 32]);
    expect(layer.placements.size).toBe(0);
  });

  it("gives every layer a unique id", () => {
    expect(createLayer("a").id).not.toBe(createLayer("a").id);
  });
});

describe("blockVariantIndex", () => {
  it("reads the variant a placed block names from its flags", async () => {
    const { blockVariantIndex } = await import("./layer");
    expect(blockVariantIndex({})).toBe(0);
    expect(blockVariantIndex({ meta: { flags: 0x1000c000 } })).toBe(0); // ghost + low bits only
    expect(blockVariantIndex({ meta: { flags: 0x10200000 } })).toBe(1); // "InPillar"
    expect(blockVariantIndex({ meta: { flags: 0x10400000 } })).toBe(2); // second layout (the mirrored loop end)
    expect(blockVariantIndex({ meta: { flags: 0x00600000 } })).toBe(3);
  });
});

describe("blockIsGround", () => {
  it("believes the map file, and its own rule only where the file is silent", async () => {
    const { blockIsGround, metaAfterMove, placementVariant } = await import("./layer");
    const at = (y: number, meta?: Record<string, unknown>) => ({ coord: [10, y, 10] as [number, number, number], ...(meta ? { meta } : {}) });
    expect(blockIsGround(at(9, { isGround: true }), true)).toBe(true);
    expect(blockIsGround(at(9, { isGround: true }), false)).toBe(true); // the file outranks our idea of the base
    expect(blockIsGround(at(13, { isGround: true }), true)).toBe(true); // on a hill: ground blocks rise with the terrain
    expect(blockIsGround(at(9, { isGround: false }), true)).toBe(false); // an air block parked at ground level
    // Made in the editor: no flag to read.
    expect(blockIsGround(at(9), true)).toBe(true);
    expect(blockIsGround(at(8), true)).toBe(false);
    expect(blockIsGround(at(9), false)).toBe(false);

    // Moving a block to another level drops what the file said about the terrain, and nothing else.
    const meta = { isGround: true, flags: 0x400000, idx: 7 };
    expect(metaAfterMove(meta, 9, 9)).toBe(meta);
    expect(metaAfterMove(meta, 9, 14)).toEqual({ flags: 0x400000, idx: 7 });
    const moved = { id: "b", kind: "block" as const, block: "X", dir: 0 as const, coord: [1, 14, 1] as [number, number, number], meta: metaAfterMove(meta, 9, 14) };
    expect(placementVariant(moved, true)).toBe("air2");
    expect(placementVariant({ ...moved, coord: [1, 9, 1], meta }, true)).toBe("ground2");
    expect(placementVariant({ ...moved, coord: [1, 9, 1], meta }, true, true)).toBe("air2"); // its layer is tilted
  });

  it("a light item carries its colour as a skin file", async () => {
    const { placementLightSkin, placementScale } = await import("./layer");
    const lamp = (meta: Record<string, unknown>) => ({ id: "i", kind: "free" as const, block: "Lamp", pos: [0, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], isItem: true, meta });
    expect(placementLightSkin(lamp({ skin: { pack: { file: "Skins\\Stadium\\LightColors\\Coral.dds", url: "" } } }))).toBe("skins\\stadium\\lightcolors\\coral.dds");
    expect(placementLightSkin(lamp({ skin: { pack: { file: "Skins\\Any\\Advertisement2x1\\Off.tga", url: "" } } }))).toBe(""); // a screen image
    expect(placementLightSkin(lamp({ skin: null }))).toBe("");
    expect(placementLightSkin({ ...lamp({ skin: { pack: { file: "Skins\\Stadium\\LightColors\\Coral.dds" } } }), isItem: false })).toBe("");
    expect(placementScale(lamp({ scale: 2.5 }))).toBe(2.5);
    expect(placementScale(lamp({}))).toBe(1);
    expect(placementScale(lamp({ scale: 0 }))).toBe(1);
  });

  it("a pillar carries the surface of the platform above it as a skin", async () => {
    const { placementSkin } = await import("./layer");
    const pillar = (skin: unknown) => ({ id: "b", kind: "block" as const, block: "DecoWallBasePillar", coord: [1, 12, 1] as [number, number, number], dir: 0 as const, meta: { flags: 0xc000, skin } });
    const none = { file: "", url: "" };
    expect(placementSkin(pillar({ text: "PlatformIce\\", pack: none, parentPack: none, foregroundPack: none }))).toBe("PlatformIce");
    expect(placementSkin(pillar(undefined))).toBe("");
    expect(placementSkin(pillar({ text: "", pack: none }))).toBe("");
    // A sign: the skin names an image, not a surface.
    expect(placementSkin(pillar({ text: "!4", pack: { file: "Skins\\Any\\Advertisement4x1\\Off.tga", url: "" } }))).toBe("");
  });

  it("a block names a mobil of its variant: Variant = row, SubVariant = column", async () => {
    const { placementMobil } = await import("./layer");
    const block = (flags: number) => ({ id: "b", kind: "block" as const, block: "StructurePillar", coord: [1, 12, 1] as [number, number, number], dir: 0 as const, meta: { flags } });
    expect(placementMobil(block(0))).toBe("");
    expect(placementMobil(block(0x10000000 | (1 << 21)))).toBe(""); // ghost, variant index 1: neither is a mobil
    expect(placementMobil(block(5))).toBe("5_0"); // a pillar's 8 m piece
    expect(placementMobil(block(1 << 6))).toBe("0_1"); // the "v2" / "B" build
    expect(placementMobil(block(2 | (1 << 6)))).toBe("2_1");
    const free = { id: "f", kind: "free" as const, block: "DecoCliffTopCornerOut10m", pos: [0, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], isItem: false, meta: { flags: 0x20000000 | (2 << 6) } };
    expect(placementMobil(free)).toBe("0_2");
    expect(placementMobil({ ...free, isItem: true, meta: { flags: 5889 } })).toBe(""); // item flags mean something else
  });

  it("a free block names its variant like a grid block, and is never ground; items have none", async () => {
    const { placementVariant } = await import("./layer");
    // RHEVARA: StructureSupportCurve1Out placed free with variant 1 (the bare curved rail) was
    // drawn as the base variant, struts and all. Flags: free (bit 29) + variant 1 (bit 21).
    const free = { id: "f", kind: "free" as const, block: "StructureSupportCurve1Out", pos: [544, 288, 320] as [number, number, number],
      rot: [0, 0, 0] as [number, number, number], isItem: false, meta: { flags: 0x20200040, isGround: false } };
    expect(placementVariant(free, true)).toBe("air1");
    expect(placementVariant({ ...free, meta: { flags: 0x20000000 } }, true)).toBe("air");
    expect(placementVariant({ ...free, meta: { flags: 0x20200040, isGround: true } }, true)).toBe("air1");
    expect(placementVariant({ ...free, isItem: true }, true)).toBe("air");
  });
});
