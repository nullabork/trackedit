import {
  AdditiveBlending,
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { withClipDefs } from "./clipAdjacency";
import type { BlockClipInfo, ClipDefs, UnitClip } from "./clipAdjacency";
import { paintHex, setColorTables } from "@core/palettes";
import type { ColorTables } from "@core/palettes";
import type { BlockDef } from "@core/catalog";
import type { GeometryProvider } from "./GeometryProvider";
import { baseVariant } from "./GeometryProvider";

/** Separates a block name from its variant in cache keys (no block name contains it). */
const KEY_SEP = "|";
import { CATEGORY_COLORS } from "./PlaceholderProvider";
import { ObjWorkerPool } from "./objWorkerPool";

async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`texture ${url}: ${res.status}`);
  return createImageBitmap(await res.blob());
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const dd = max - min;
  const s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
  let h;
  if (max === r) h = (g - b) / dd + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / dd + 2;
  else h = (r - g) / dd + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

interface MeshIndexEntry {
  size?: [number, number, number] | null;
  air?: string | null;
  ground?: string | null;
  /** Items: single OBJ. */
  obj?: string | null;
  /** Unit offsets per variant (meshdump UnitTable). */
  units?: Record<string, [number, number, number][] | null> | null;
  /** Clips per unit face per variant (meshdump ClipTable). */
  clips?: Record<string, UnitClip[] | null> | null;
  /** "<variant>@<row>_<col>" mobils that have no geometry at all: nothing is drawn. */
  emptyMobils?: string[] | null;
}

/** "air1@2_0#PlatformIce" -> ["air1@2_0", "PlatformIce"]: the surface skin rides at the end. */
const splitSkin = (variant: string): [string, string] => {
  const at = variant.indexOf("#");
  return at < 0 ? [variant, ""] : [variant.slice(0, at), variant.slice(at + 1)];
};
/** "air1@2_0" -> "air1": the variant a mobil belongs to (units, clips and fallback mesh are per variant). */
const variantOfMobil = (variant: string): string => {
  const plain = splitSkin(variant)[0];
  return plain.includes("@") ? plain.slice(0, plain.indexOf("@")) : plain;
};
/** skins.json: placement skin -> base material -> the material that replaces it. */
type SkinTable = Record<string, Record<string, string> | undefined>;

/** Additional variants that differ from their base ride along as air1, air2, ground1, … -> OBJ path. */
const variantPath = (entry: MeshIndexEntry | undefined, variant: string): string | null =>
  ((entry as Record<string, unknown> | undefined)?.[variant] as string | null | undefined) ?? null;

interface MeshIndex {
  blocks: Record<string, MeshIndexEntry>;
  items?: Record<string, MeshIndexEntry>;
}

type MaterialIndex = Record<
  string,
  {
    texture: string | null;
    color?: string;
    colorable?: boolean;
    /** Colour target table the material paints through (Default when absent). */
    colorTable?: string;
    hueMask?: string;
    /** Decal shader: an alpha layer drawn ON another surface (coplanar). */
    decal?: boolean;
    /** Water surface (the game ships only a normal map): draw as translucent blue. */
    water?: boolean;
    /** Alpha-textured glass wall: draw translucent. */
    translucent?: boolean;
    /** "add" = additive glow strip (the game's TAdd shaders). */
    blend?: "add";
    /** The game image the texture was made from; "*_I.dds" is a self-illumination map. */
    source?: string;
  }
>;

import type { MeshVariant } from "./GeometryProvider";
export type { MeshVariant };

/**
 * Material names as the extraction keys them: "TrackBorders", or
 * "PlatformIce.PlatformTech" for a terrain-modifier variant. Meshes written
 * by older extractions name materials by their game path instead
 * ("Stadium\\Media\\Modifier\\PlatformIce\\PlatformTech") — same
 * rule as meshdump's EmbeddedDumper.CanonicalMaterialName.
 */
export function canonicalMaterialName(name: string): string {
  const parts = name.split(/[\\/]/);
  const stem = (parts.pop() ?? name).replace(/\.Material\.gbx$/i, "").replace(/\.gbx$/i, "");
  const mod = parts.findIndex((p) => p.toLowerCase() === "modifier");
  const folder = mod >= 0 && mod + 1 < parts.length ? parts[mod + 1] : null;
  return folder ? `${folder}.${stem}` : stem;
}

/**
 * Serves real block meshes extracted from the user's game files by
 * tools/meshdump (public/meshes/index.json + one OBJ per block/variant).
 *
 * getTemplate() is synchronous by contract, so unknown meshes return the
 * fallback (placeholder box) immediately while the OBJ loads in the
 * background; `onLoaded` then lets the renderer rebuild affected placements.
 * Blocks absent from the index permanently use the fallback.
 */
export class MeshProvider implements GeometryProvider {
  private index: MeshIndex | null = null;
  private clipDefs: ClipDefs = {};
  private skins: SkinTable = {};
  /** lightcolors.json: light skin file (lower-case) -> "#rrggbb". */
  private lightColors: Record<string, string | undefined> = {};
  private readonly clipInfos = new Map<string, BlockClipInfo>();
  private materialIndex: MaterialIndex = {};
  private cache = new Map<string, Object3D>();
  private pending = new Set<string>();
  private loader = new OBJLoader();
  private textureLoader = new TextureLoader();
  private materials = new Map<string, MeshLambertMaterial>();
  /** Every material instance created for a usemtl name — mod swaps hit these. */
  private materialsByName = new Map<string, MeshLambertMaterial[]>();
  private activeModMaterials: Record<string, string> | null = null;
  private activeModBase = "";
  /** Big maps request hundreds of meshes at once; parse a few at a time so
   * the main thread never freezes on an OBJ-parse storm. */
  private loadQueue: Array<{ pos: [number, number, number] | null; run: () => void }> = [];
  private inFlight = 0;
  private readonly workers = ObjWorkerPool.create();
  /** With workers a load costs the page nothing, so keep every one of them fed. */
  private get maxInFlight(): number {
    return this.workers ? this.workers.size * 2 : 4;
  }
  /** Representative world position per block, for nearest-first loading. */
  private positions = new Map<string, [number, number, number]>();
  /** Injected by main: current camera position, used to prioritise the queue. */
  cameraPos: (() => { x: number; y: number; z: number }) | null = null;

  /** Remember roughly where a block lives so its load can be prioritised. */
  hintPosition(name: string, x: number, y: number, z: number): void {
    if (!this.positions.has(name)) this.positions.set(name, [x, y, z]);
  }

  isLoaded(name: string): boolean {
    return this.cache.has(name);
  }

  setLite(lite: boolean): void {
    (this.fallback as { setLite?: (l: boolean) => void }).setLite?.(lite);
  }

  /** Nearest-to-camera first: the world materialises around the player. */
  private pump(): void {
    while (this.inFlight < this.maxInFlight && this.loadQueue.length > 0) {
      let idx = 0;
      const cam = this.cameraPos?.();
      if (cam && this.loadQueue.length > 1) {
        let best = Infinity;
        for (let i = 0; i < this.loadQueue.length; i++) {
          const p = this.loadQueue[i].pos;
          const d = p
            ? (p[0] - cam.x) ** 2 + (p[1] - cam.y) ** 2 + (p[2] - cam.z) ** 2
            : Infinity;
          if (d < best) {
            best = d;
            idx = i;
          }
        }
      }
      const [item] = this.loadQueue.splice(idx, 1);
      this.inFlight += 1;
      item.run();
    }
  }

  private loadDone(): void {
    this.inFlight -= 1;
    this.pump();
  }

  /** The material shows a self-illumination map (the extractor found no diffuse, only "*_I.dds"): it IS the light. */
  private isSelfIllum(name: string): boolean {
    const entry = this.materialIndex[name] ?? this.materialIndex[canonicalMaterialName(name)];
    return /_I\.dds$/i.test(entry?.source ?? "");
  }

  /** `base` glowing in a light skin's colour; one per material and colour. */
  private litMaterial(base: MeshLambertMaterial, name: string, hex: string): MeshLambertMaterial {
    const key = `lit:${name}:${hex}`;
    let lit = this.materials.get(key);
    if (!lit) {
      lit = base.clone();
      lit.color.set(hex);
      lit.emissive.set(hex);
      // "Off" is black: no glow, and the dark shape stays visible under the scene light.
      lit.emissiveIntensity = hex === "#000000" ? 0 : 0.85;
      lit.emissiveMap = base.map;
      lit.userData.matName = name;
      this.materials.set(key, lit);
    }
    return lit;
  }

  /**
   * Material for one OBJ usemtl group: the extracted diffuse texture when
   * meshdump found one, otherwise a flat category tint.
   */
  private materialFor(name: string, category: string | undefined): MeshLambertMaterial {
    const entry = this.materialIndex[name] ?? this.materialIndex[canonicalMaterialName(name)];
    const texture = entry?.texture ?? null;
    // Flat-color materials cover content with no texture on disk (e.g. the
    // proxy meshes for procedural vegetation).
    const flat = !texture && entry?.color ? entry.color : null;
    const key = entry?.water
      ? "water"
      : (texture ?? (flat ? `flat:${flat}` : `tint:${CATEGORY_COLORS[category ?? ""] ?? 0x9aa4ae}`)) +
        (entry?.translucent ? "|t" : "");
    let mat = this.materials.get(key);
    if (!mat) {
      if (flat) {
        mat = new MeshLambertMaterial({ color: flat, side: DoubleSide });
      } else if (entry?.water) {
        mat = new MeshLambertMaterial({
          color: 0x5cc3ea,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          side: DoubleSide,
        });
      } else if (texture && entry?.translucent) {
        mat = new MeshLambertMaterial({
          map: this.loadTexture(this.baseUrl + texture),
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          side: DoubleSide,
        });
      } else if (texture && entry?.blend === "add") {
        // Glow strips (turbo/boost FX): additive, never occlude anything.
        mat = new MeshLambertMaterial({
          map: this.loadTexture(this.baseUrl + texture),
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
        });
      } else if (texture && entry?.decal) {
        // Decals sit exactly ON the surface they mark (the game's decal
        // shaders depth-bias them). Without the offset the two coplanar
        // layers z-fight: half the top face shows the base, half the decal.
        mat = new MeshLambertMaterial({
          map: this.loadTexture(this.baseUrl + texture),
          transparent: true,
          alphaTest: 0.02,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
          side: DoubleSide,
        });
      } else if (texture) {
        const map = this.loadTexture(this.baseUrl + texture);
        // alphaTest handles cut-out textures (fences, grates) without sorting.
        // DoubleSide: the game treats many block surfaces as two-sided —
        // without it, undersides/backsides of pieces vanish.
        mat = new MeshLambertMaterial({ map, alphaTest: 0.4, side: DoubleSide });
      } else {
        mat = new MeshLambertMaterial({
          color: CATEGORY_COLORS[category ?? ""] ?? 0x9aa4ae,
          side: DoubleSide,
        });
      }
      this.materials.set(key, mat);
    }
    mat.userData.matName = name;
    const list = this.materialsByName.get(name) ?? [];
    if (!list.includes(mat)) {
      list.push(mat);
      this.materialsByName.set(name, list);
      // A mod may already be active when this material is first created
      // (meshes stream in lazily) — apply its override immediately.
      const modTex = this.activeModMaterials?.[name];
      if (modTex) this.overrideMaterial(mat, this.activeModBase + modTex);
    }
    return mat;
  }

  /**
   * Recolor a cloned object for a painted placement. `hex` is the palette-
   * resolved color (see core/palettes.ts). Faithful to the game: only the
   * pixels selected by a material's HueMask change color — the rest of the
   * texture (road surface, panel detail) stays stock.
   */
  colorize(root: Object3D, palette: string, slot: string): void {
    root.traverse((o) => {
      const holder = o as Mesh;
      if (!(holder instanceof Mesh) || !holder.material) return;
      const swap = (m: MeshLambertMaterial): MeshLambertMaterial => {
        const name = m.userData?.matName as string | undefined;
        const entry = name ? this.materialIndex[name] : undefined;
        if (!name || !entry?.colorable) return m;
        // The slot's colour depends on this material's colour table.
        const hex = paintHex(palette, slot, entry.colorTable ?? "Default");
        if (!hex) return m;
        const key = `paint:${hex}:${name}`;
        let painted = this.materials.get(key);
        if (!painted) {
          // Start as a clone of the stock material; the mask-tinted texture
          // swaps in asynchronously once the canvas bake finishes.
          painted = m.clone();
          painted.userData.matName = name;
          painted.userData.paintHex = hex;
          painted.userData.paintTable = entry.colorTable ?? "Default";
          this.materials.set(key, painted);
          const target = painted;
          void this.bakeTinted(name, entry, hex).then((tex) => {
            if (!tex) {
              // No mask available: modest flat tint fallback.
              target.color.set(hex);
              target.needsUpdate = true;
              return;
            }
            target.map = tex;
            target.needsUpdate = true;
          });
        }
        return painted;
      };
      holder.material = Array.isArray(holder.material)
        ? (holder.material as MeshLambertMaterial[]).map(swap)
        : swap(holder.material as MeshLambertMaterial);
    });
  }

  /** Bake base texture + HueMask + color into a tinted texture (cached). */
  private tintBakes = new Map<string, Promise<Texture | null>>();

  private bakeTinted(name: string, entry: MaterialIndex[string], hex: string): Promise<Texture | null> {
    const key = `${name}:${hex}`;
    let bake = this.tintBakes.get(key);
    if (bake) return bake;
    bake = (async () => {
      if (!entry.texture || !entry.hueMask) return null;
      try {
        const [base, mask] = await Promise.all([
          loadBitmap(this.baseUrl + entry.texture),
          loadBitmap(this.baseUrl + entry.hueMask),
        ]);
        const w = base.width;
        const h = base.height;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        // Mask strength rides in the GREEN channel (meshdump flattens alpha).
        ctx.drawImage(mask, 0, 0, w, h);
        const maskData = ctx.getImageData(0, 0, w, h).data;

        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(base, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;

        // Game-style repaint: masked pixels take the tint's HUE but keep
        // their own saturation (gray asphalt stays gray, colored trims
        // recolor) and their own brightness scaled by the shade — so one
        // paint yields bright borders, tinted skirts AND dark panels.
        const [th, , tl] = rgbToHsl(
          parseInt(hex.slice(1, 3), 16),
          parseInt(hex.slice(3, 5), 16),
          parseInt(hex.slice(5, 7), 16),
        );
        for (let i = 0; i < d.length; i += 4) {
          const s = maskData[i + 1] / 255;
          if (s <= 0.02) continue;
          const [, baseS, baseL] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
          const outL = Math.min(1, baseL * tl * 2);
          const [r, g, b] = hslToRgb(th, baseS, outL);
          d[i] = d[i] * (1 - s) + r * s;
          d[i + 1] = d[i + 1] * (1 - s) + g * s;
          d[i + 2] = d[i + 2] * (1 - s) + b * s;
        }
        ctx.putImageData(img, 0, 0);

        const tex = new CanvasTexture(canvas);
        tex.colorSpace = SRGBColorSpace;
        tex.wrapS = tex.wrapT = RepeatWrapping;
        return tex as Texture;
      } catch {
        return null;
      }
    })();
    this.tintBakes.set(key, bake);
    return bake;
  }

  private loadTexture(url: string) {
    const map = this.textureLoader.load(url);
    map.colorSpace = SRGBColorSpace;
    map.wrapS = map.wrapT = RepeatWrapping;
    return map;
  }

  private overrideMaterial(mat: MeshLambertMaterial, url: string): void {
    if (mat.userData.baseMap === undefined) mat.userData.baseMap = mat.map;
    mat.map = this.loadTexture(url);
    mat.needsUpdate = true;
  }

  /**
   * Apply (or clear, with null) a mod's texture overrides. Swaps texture
   * maps on the live shared materials — no geometry rebuilds needed.
   */
  applyMod(materials: Record<string, string> | null, base = ""): void {
    this.activeModMaterials = materials;
    this.activeModBase = base;
    for (const [name, mats] of this.materialsByName) {
      const modTex = materials?.[name];
      for (const mat of mats) {
        if (modTex) {
          this.overrideMaterial(mat, base + modTex);
        } else if (mat.userData.baseMap !== undefined) {
          mat.map = mat.userData.baseMap;
          delete mat.userData.baseMap;
          mat.needsUpdate = true;
        }
      }
    }
  }

  /** Called with a block name when its real mesh finished loading. */
  onLoaded: (blockName: string) => void = () => {};

  constructor(
    private fallback: GeometryProvider,
    private baseUrl = "meshes/",
  ) {}

  /** Fetch the mesh + material indexes; absence is fine (placeholder-only mode). */
  async init(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + "index.json");
      if (!res.ok) return false;
      this.index = (await res.json()) as MeshIndex;
      const mats = await fetch(this.baseUrl + "materials.json");
      if (mats.ok) this.materialIndex = (await mats.json()) as MaterialIndex;
      const defs = await fetch(this.baseUrl + "clipdefs.json");
      if (defs.ok) this.clipDefs = (await defs.json()) as ClipDefs;
      else console.warn("meshes/clipdefs.json is missing — clip pieces cannot be hidden correctly; run `meshdump clipdefs` or re-extract the blocks");
      const skins = await fetch(this.baseUrl + "skins.json");
      if (skins.ok) this.skins = (await skins.json()) as SkinTable;
      const lights = await fetch(this.baseUrl + "lightcolors.json");
      if (lights.ok) this.lightColors = (await lights.json()) as Record<string, string>;
      const tables = await fetch(this.baseUrl + "colortables.json");
      if (tables.ok) setColorTables((await tables.json()) as ColorTables);
      return true;
    } catch {
      return false;
    }
  }

  blockClips(name: string, variant: MeshVariant): BlockClipInfo | undefined {
    const entry = this.index?.blocks[name];
    if (!entry) return undefined;
    variant = variantOfMobil(variant);
    const cached = this.clipInfos.get(name + KEY_SEP + variant);
    if (cached) return cached;
    // A variant without its own table borrows its base's, then the other
    // base's (several blocks model only air or only ground).
    const base = baseVariant(variant);
    const other = base === "air" ? "ground" : "air";
    const units = entry.units?.[variant] ?? entry.units?.[base] ?? entry.units?.[other] ?? [];
    const clips = entry.clips?.[variant] ?? entry.clips?.[base] ?? entry.clips?.[other] ?? [];
    const info: BlockClipInfo = { size: entry.size ?? [1, 1, 1], units, clips: withClipDefs(clips, this.clipDefs) };
    this.clipInfos.set(name + KEY_SEP + variant, info);
    return info;
  }

  /** Footprint sizes from the extraction, for catalog enrichment. */
  get sizes(): ReadonlyMap<string, [number, number, number]> {
    const map = new Map<string, [number, number, number]>();
    for (const [name, e] of Object.entries(this.index?.blocks ?? {}))
      if (e.size) map.set(name, e.size);
    return map;
  }

  /** Cache key for a block+variant. Ground requests fall back to the air key
   * when no ground OBJ exists (and vice versa), so nothing loads twice. */
  private variantKey(base: string, variant: MeshVariant): string {
    // A surface skin this extraction knows makes a template of its own (same mesh, other materials).
    const [plain, skin] = splitSkin(variant);
    if (skin.startsWith("light:")) return this.plainKey(base, plain) + (this.lightColors[skin.slice(6)] ? `#${skin}` : "");
    if (skin) return this.plainKey(base, plain) + (this.skins[skin] ? `#${skin}` : "");
    return this.plainKey(base, plain);
  }

  private plainKey(base: string, variant: MeshVariant): string {
    const entry = this.index?.blocks[base];
    // A mobil with a mesh of its own (or with none at all); otherwise whatever its variant shows.
    if (variant.includes("@")) {
      if (variantPath(entry, variant) || entry?.emptyMobils?.includes(variant)) return base + KEY_SEP + variant;
      variant = variantOfMobil(variant);
    }
    // An additional variant with a mesh of its own; otherwise its base.
    if (variant !== "air" && variant !== "ground" && variantPath(entry, variant)) return base + KEY_SEP + variant;
    if (baseVariant(variant) !== "ground") return base;
    return entry?.ground ? base + KEY_SEP + "ground" : base;
  }

  getTemplate(
    def: BlockDef | undefined,
    name: string,
    load = true,
    variant: MeshVariant = "air",
  ): Object3D {
    const base = def?.name ?? name;
    const key = this.variantKey(base, variant);
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.index?.blocks[base]?.emptyMobils?.includes(splitSkin(variant)[0])) {
      // e.g. the empty row of a pillar: the game draws nothing, and so do we.
      const nothing = new Group();
      this.cache.set(key, nothing);
      return nothing;
    }
    if (load) this.requestLoad(def, name, variant);
    return this.fallback.getTemplate(def, name);
  }

  /** Queue the real mesh for a block (dedup'd); safe to call repeatedly. */
  requestLoad(def: BlockDef | undefined, name: string, variant: MeshVariant = "air"): void {
    const base = def?.name ?? name;
    const key = this.variantKey(base, variant);
    if (this.cache.has(key) || this.pending.has(key)) return;
    const entry = this.index?.blocks[base] ?? this.index?.items?.[base];
    // In-game, elevated blocks use the air variant (with underside geometry);
    // only terrain-seated blocks show the underside-less ground variant.
    const [meshKey, skin] = splitSkin(key);
    const own = meshKey.includes(KEY_SEP) ? meshKey.slice(meshKey.indexOf(KEY_SEP) + 1) : null;
    const objPath = own === null ? (entry?.air ?? entry?.obj ?? entry?.ground)
      : own === "ground" ? entry?.ground
      : variantPath(entry, own);
    if (!entry || !objPath) return;
    this.pending.add(key);
    this.loadQueue.push({
      pos: this.positions.get(base) ?? null,
      run: () => this.loadNow(key, base, objPath, entry, def?.category, this.skins[skin],
        skin.startsWith("light:") ? this.lightColors[skin.slice(6)] : undefined),
    });
    this.pump();
  }

  private loadNow(
    key: string,
    base: string,
    objPath: string,
    entry: MeshIndexEntry,
    category?: string,
    /** A placement skin's swaps: base material name -> replacement. */
    swaps?: Record<string, string>,
    /** A light skin's colour: the item's self-illuminated materials glow in it. */
    lightColor?: string,
  ): void {
    const material = (name: string) => {
      const mat = this.materialFor(swaps?.[name] ?? name, category);
      return lightColor && this.isSelfIllum(name) ? this.litMaterial(mat, name, lightColor) : mat;
    };
    const finish = (obj: Object3D) => {
        // Extracted meshes are modelled from the block's min corner. Tag the
        // template so DocumentRenderer can anchor it correctly per placement
        // kind (grid blocks pivot around the footprint centre, free blocks
        // use the raw origin).
        obj.name = base;
        // Alternative wall-panel segments ("clip:…~a", "~b", "~ab") are off until a renderer
        // that knows the neighbours picks one: previews and thumbnails show the plain parts.
        obj.traverse((o) => { if (o.name.startsWith("clip:") && o.name.includes("~")) o.visible = false; });
        obj.userData.anchor = "corner";
        obj.userData.sizeCells = entry.size ?? [1, 1, 1];
        this.cache.set(key, obj);
        this.pending.delete(key);
        this.onLoaded(base);
    };
    const failed = () => {
      this.loadDone();
      this.pending.delete(key);
    };

    // Fetching, parsing and shading happen in a worker pool: every core at
    // once, nothing on the page's thread (see objWorker.ts).
    if (this.workers) {
      void this.workers.load(this.baseUrl + objPath, material).then((obj) => {
        this.loadDone();
        finish(obj);
      }, failed);
      return;
    }
    this.loader.load(
      this.baseUrl + objPath,
      (obj) => {
        this.loadDone();
        obj.traverse((o) => {
          if (o instanceof Mesh) {
            o.geometry.computeVertexNormals();
            // OBJLoader names materials after their usemtl group; a mesh with
            // several groups carries an array of them.
            const replace = (m: { name?: string }) =>
              material(m.name || "default");
            o.material = Array.isArray(o.material)
              ? o.material.map(replace)
              : replace(o.material as { name?: string });
          }
        });
        finish(obj);
      },
      undefined,
      failed,
    );
  }
}
