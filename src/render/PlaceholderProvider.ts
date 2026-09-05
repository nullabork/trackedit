import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
} from "three";
import type { Object3D } from "three";
import type { BlockDef } from "@core/catalog";
import { CELL } from "@core/math";
import type { GeometryProvider } from "./GeometryProvider";

/** Stable colour per category so placeholder scenes stay readable. */
export const CATEGORY_COLORS: Record<string, number> = {
  "Road Tech": 0x8a8f98,
  "Road Dirt": 0xb07a45,
  "Road Bump": 0x9a6a4f,
  "Road Ice": 0xa8d8e8,
  Road: 0x7f848c,
  "Platform Tech": 0x5f6670,
  "Platform Dirt": 0x8d6238,
  "Platform Ice": 0x9cc8dc,
  "Platform Plastic": 0xd8c24a,
  "Platform Grass": 0x5f9e4f,
  Platform: 0x6a7078,
  Canopy: 0xc0c6ce,
  Decoration: 0x7fa0b8,
  Structure: 0x9aa4b0,
  Stage: 0x8878b0,
  Gate: 0xd07850,
  "Snow Road": 0xe8ecf2,
  Items: 0x50b8a0,
  Other: 0x808890,
};

function hashHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return ((h >>> 0) % 360) / 360;
}

/**
 * Renders every block as a translucent box the size of its grid footprint
 * (1x1x1 cells when unknown), coloured by category, with a bright edge
 * outline. Items become small boxes. Good enough to edit real maps with
 * until extracted meshes arrive.
 */
export class PlaceholderProvider implements GeometryProvider {
  private cache = new Map<string, Object3D>();
  /** Lite mode (huge maps): no edge outlines — halves the draw calls. */
  private lite = false;

  setLite(lite: boolean): void {
    this.lite = lite;
  }

  getTemplate(def: BlockDef | undefined, name: string): Object3D {
    const key = `${def?.name ?? name}|${this.lite ? "l" : "f"}`;
    let tpl = this.cache.get(key);
    if (!tpl) {
      tpl = this.build(def, name);
      this.cache.set(key, tpl);
    }
    return tpl;
  }

  private build(def: BlockDef | undefined, name: string): Object3D {
    const isItem = def?.kind === "item";
    const size = def?.size ?? [1, 1, 1];
    const w = isItem ? 4 : size[0] * CELL[0] - 0.8;
    const h = isItem ? 4 : size[1] * CELL[1] - 0.4;
    const d = isItem ? 4 : size[2] * CELL[2] - 0.8;

    let color = CATEGORY_COLORS[def?.category ?? ""];
    if (color === undefined) {
      const hue = hashHue(def?.category ?? name);
      color = hslToHex(hue, 0.35, 0.55);
    }

    const geo = new BoxGeometry(w, h, d);
    // Box centred in footprint, resting on the cell floor.
    geo.translate(0, h / 2, 0);
    const mesh = new Mesh(
      geo,
      new MeshLambertMaterial({ color, transparent: true, opacity: 0.92 }),
    );
    const group = new Group();
    group.add(mesh);
    if (!this.lite) {
      group.add(new LineSegments(
        new EdgesGeometry(geo),
        new LineBasicMaterial({ color: 0x20242a }),
      ));
    }
    group.name = key(def, name);
    return group;
  }
}

function key(def: BlockDef | undefined, name: string): string {
  return def?.name ?? name;
}

function hslToHex(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
