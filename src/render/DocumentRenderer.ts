import {
  BoxGeometry,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Euler,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  MathUtils,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Raycaster,
  ShaderMaterial,
  Vector3,
} from "three";
import type { MapDocument } from "@core/document";
import type { Layer, Placement } from "@core/layer";
import type { BlockCatalog, BlockDef } from "@core/catalog";
import { CELL, DEFAULT_Y_OFFSET, degToRad } from "@core/math";
import { baseTypeOf } from "@core/mapbase";
import { paintHex } from "@core/palettes";
import type { GeometryProvider } from "./GeometryProvider";
import { CATEGORY_COLORS } from "./PlaceholderProvider";
import type { SceneView } from "./SceneView";

export interface PickResult {
  layerId: string;
  placementId: string;
  object: Object3D;
}

/** Optional streaming hooks a provider may offer (MeshProvider does). */
interface StreamingProvider extends GeometryProvider {
  isLoaded?(name: string): boolean;
  requestLoad?(def: BlockDef | undefined, name: string, variant?: "air" | "ground"): void;
  hintPosition?(name: string, x: number, y: number, z: number): void;
  setLite?(lite: boolean): void;
  colorize?(root: Object3D, paint: string): void;
}

/** LOD bookkeeping per placement (LAYER-LOCAL position; world positions are
 * derived fresh with the layer's full transform, so rotated/translated
 * layers classify correctly and never go stale). */
interface LodInfo {
  layerId: string;
  block: string;
  lx: number;
  ly: number;
  lz: number;
}

/** Per-layer world transform snapshot used during one classification pass. */
interface LayerXf {
  layer: Layer;
  q: Quaternion;
  tx: number;
  ty: number;
  tz: number;
  near2: number;
  far2: number;
}

/** Maps beyond this many placements get the LOD treatment. */
const LARGE_MAP = 3000;
const CLASSIFY_EVERY_N_FRAMES = 15;

/**
 * Mirrors the MapDocument into the three.js scene, one Group per layer so
 * layer transforms and visibility are a single group update.
 *
 * Large maps use two representations (LOD): placements near the camera are
 * individual objects with real meshes; far placements have NO Object3D at
 * all — they live purely as entries in one InstancedMesh of
 * category-coloured boxes per layer. Flying around promotes/demotes
 * placements between the two, so imports are instant, the far view is a few
 * draw calls, and real meshes stream in around the camera.
 */
export class DocumentRenderer {
  private layerGroups = new Map<string, Group>();
  private placementObjects = new Map<string, Object3D>();
  /** blockName -> placement ids, so mesh hot-swaps touch only their own. */
  private byBlock = new Map<string, Set<string>>();
  private root = new Group();

  // --- LOD state ---
  private largeMap = false;
  private lodInfo = new Map<string, LodInfo>();
  private farSet = new Set<string>();
  private pools = new Map<string, InstancedMesh>();
  private dirtyPools = new Set<string>();
  private frame = 0;
  private poolGeometry: BoxGeometry;
  private poolMaterial = new MeshLambertMaterial();

  constructor(
    private doc: MapDocument,
    private view: SceneView,
    private catalog: BlockCatalog,
    private geometry: StreamingProvider,
  ) {
    this.root.name = "document";
    view.scene.add(this.root);
    this.poolGeometry = new BoxGeometry(1, 1, 1);
    this.poolGeometry.translate(0, 0.5, 0);

    const ev = doc.events;
    ev.on("placementAdded", ({ layer, placement }) => this.addPlacement(layer, placement));
    ev.on("placementRemoved", ({ placement }) => this.removePlacement(placement.id));
    ev.on("layerAdded", ({ layer }) => this.ensureLayerGroup(layer));
    ev.on("layerRemoved", ({ layer }) => this.dropLayerGroup(layer.id));
    ev.on("layerChanged", ({ layer }) => this.syncLayerGroup(layer));
    ev.on("activeLayerChanged", () => this.refreshPlaneOutlines());
    ev.on("mapChanged", () => {
      this.rebuildPlaneOutlines();
      // Palette switches restyle every painted placement.
      if (doc.colorPalette !== this.lastPalette) {
        this.lastPalette = doc.colorPalette;
        this.refreshPainted();
      }
    });
    ev.on("reset", () => {
      this.lastPalette = doc.colorPalette;
      this.rebuild();
    });
    view.onFrame(() => this.lodTick());
    view.onFrame(() => this.updateGridFade());
    this.rebuild();
  }

  rebuild(): void {
    this.root.clear();
    this.layerGroups.clear();
    this.placementObjects.clear();
    this.byBlock.clear();
    this.lodInfo.clear();
    this.farSet.clear();
    for (const pool of this.pools.values()) pool.dispose();
    this.pools.clear();
    this.dirtyPools.clear();

    let total = 0;
    for (const layer of this.doc.layers) total += layer.placements.size;
    this.largeMap = total > LARGE_MAP;
    this.geometry.setLite?.(this.largeMap);

    for (const layer of this.doc.layers) {
      this.ensureLayerGroup(layer);
      for (const p of layer.placements.values()) this.addPlacement(layer, p);
    }
  }

  // --- layer groups & plane outlines ---

  private ensureLayerGroup(layer: Layer): Group {
    let g = this.layerGroups.get(layer.id);
    if (!g) {
      g = new Group();
      g.name = `layer:${layer.id}`;
      this.layerGroups.set(layer.id, g);
      this.root.add(g);
      this.addPlaneOutline(g);
      this.addLayerGrid(g, layer);
      this.refreshPlaneOutlines();
    }
    this.syncLayerGroup(layer, g);
    return g;
  }

  private syncLayerGroup(layer: Layer, group = this.layerGroups.get(layer.id)): void {
    if (!group) return;
    group.visible = layer.visible;
    group.position.set(...layer.transform.translate);
    const [rx, ry, rz] = layer.transform.rotDeg;
    group.rotation.set(degToRad(rx), degToRad(ry), degToRad(rz), "YXZ");
    // Grid spacing changed? Rebuild this layer's grid lines.
    const grid = group.getObjectByName("layerGrid");
    const step = `${Math.max(layer.settings.gridStep[0], 1)}x${Math.max(layer.settings.gridStep[2], 1)}`;
    if (grid && grid.userData.step !== step) {
      grid.removeFromParent();
      this.addLayerGrid(group, layer);
      this.refreshPlaneOutlines();
    }
  }

  private addPlaneOutline(group: Group): void {
    const w = this.doc.size[0] * CELL[0];
    const d = this.doc.size[2] * CELL[2];
    const geo = new BufferGeometry().setFromPoints([
      new Vector3(0, 0, 0),
      new Vector3(w, 0, 0),
      new Vector3(w, 0, d),
      new Vector3(0, 0, d),
    ]);
    const line = new LineLoop(geo, new LineBasicMaterial({ color: 0xff8c1a }));
    line.name = "layerPlane";
    line.raycast = () => {};
    group.add(line);
  }

  /**
   * Each layer draws its OWN grid: its gridStep spacing, riding the layer's
   * rotation/translation. Only the active layer's grid is shown. Lines fade
   * radially around the point the camera is looking at (updateGridFade) —
   * far away the packed lines would otherwise merge into a dark mass.
   */
  private addLayerGrid(group: Group, layer: Layer): void {
    const w = this.doc.size[0] * CELL[0];
    const d = this.doc.size[2] * CELL[2];
    const sx = Math.max(layer.settings.gridStep[0], 1);
    const sz = Math.max(layer.settings.gridStep[2], 1);
    const points: Vector3[] = [];
    for (let x = 0; x <= w + 0.001; x += sx) points.push(new Vector3(x, 0, 0), new Vector3(x, 0, d));
    for (let z = 0; z <= d + 0.001; z += sz) points.push(new Vector3(0, 0, z), new Vector3(w, 0, z));
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uColor: { value: new Color(0x2f3a46) },
        uOpacity: { value: 0.8 },
        uCenter: { value: new Vector3() },
        uRadius: { value: 1500 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform vec3 uCenter;
        uniform float uRadius;
        varying vec3 vWorld;
        void main() {
          float d = distance(vWorld, uCenter);
          float a = uOpacity * (1.0 - smoothstep(uRadius * 0.3, uRadius, d));
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    const grid = new LineSegments(new BufferGeometry().setFromPoints(points), material);
    grid.name = "layerGrid";
    grid.raycast = () => {};
    grid.userData.step = `${sx}x${sz}`;
    group.add(grid);
  }

  // Scratch objects for the per-frame grid fade update (no allocations).
  private gfQuat = new Quaternion();
  private gfNormal = new Vector3();
  private gfPlanePt = new Vector3();
  private gfDir = new Vector3();
  private gfTmp = new Vector3();
  private gfCenter = new Vector3();

  /**
   * Per frame: aim the grid's fade circle at the spot the camera looks at —
   * view ray ∩ the active layer's (possibly tilted) grid plane. At grazing
   * angles that hit runs to the horizon, which would center the circle miles
   * away and fade out everything nearby — so the center is clamped to a
   * distance proportional to the camera's height over the plane, then
   * dropped back onto it. Radius scales with the distance to the center and
   * the user's grid-distance preference (render settings slider).
   */
  updateGridFade(): void {
    const group = this.layerGroups.get(this.doc.activeLayer.id);
    const grid = group?.getObjectByName("layerGrid") as LineSegments | undefined;
    if (!group || !grid || !grid.visible) return;
    const mat = grid.material as ShaderMaterial;
    if (!mat.uniforms?.uCenter) return;

    const prefs = this.view.getRenderPrefs();
    const pct = MathUtils.clamp(prefs.gridFade, 0, 100) / 100;
    if (grid.userData.gridColor !== prefs.gridColor) {
      (mat.uniforms.uColor.value as Color).set(prefs.gridColor);
      grid.userData.gridColor = prefs.gridColor;
    }
    const normal = this.gfNormal.set(0, 1, 0).applyQuaternion(group.getWorldQuaternion(this.gfQuat));
    const planePt = group.getWorldPosition(this.gfPlanePt);
    const cam = this.view.camera;
    const dir = cam.getWorldDirection(this.gfDir);
    const denom = dir.dot(normal);
    const lift = this.gfTmp.copy(cam.position).sub(planePt).dot(normal);
    const t = Math.abs(denom) > 1e-4
      ? this.gfTmp.copy(planePt).sub(cam.position).dot(normal) / denom
      : -1;
    const maxAhead = Math.abs(lift) * (2 + 8 * pct) + 400;
    const center = this.gfCenter;
    if (t > 0) {
      center.copy(dir).multiplyScalar(Math.min(t, maxAhead)).add(cam.position);
    } else {
      center.copy(cam.position);
    }
    // Drop the (possibly clamped, off-plane) center onto the grid plane.
    const off = this.gfTmp.copy(center).sub(planePt).dot(normal);
    center.addScaledVector(normal, -off);

    (mat.uniforms.uCenter.value as Vector3).copy(center);
    const reach = (0.35 + 3.15 * pct) * Math.max(cam.position.distanceTo(center), 250);
    mat.uniforms.uRadius.value = MathUtils.clamp(reach, 300, 20000);
  }

  private rebuildPlaneOutlines(): void {
    for (const [layerId, group] of this.layerGroups) {
      group.getObjectByName("layerPlane")?.removeFromParent();
      group.getObjectByName("layerGrid")?.removeFromParent();
      this.addPlaneOutline(group);
      const layer = this.doc.getLayer(layerId);
      if (layer) this.addLayerGrid(group, layer);
    }
    this.refreshPlaneOutlines();
  }

  private refreshPlaneOutlines(): void {
    const activeId = this.doc.activeLayer.id;
    for (const [layerId, group] of this.layerGroups) {
      const active = layerId === activeId;
      const line = group.getObjectByName("layerPlane") as LineLoop | undefined;
      if (line) {
        const mat = line.material as LineBasicMaterial;
        mat.color.set(active ? 0xff8c1a : 0x4a5563);
        mat.transparent = !active;
        mat.opacity = active ? 1 : 0.5;
      }
      const grid = group.getObjectByName("layerGrid");
      if (grid) grid.visible = active;
    }
  }

  private dropLayerGroup(layerId: string): void {
    const g = this.layerGroups.get(layerId);
    if (!g) return;
    for (const [id, info] of [...this.lodInfo]) {
      if (info.layerId !== layerId) continue;
      this.lodInfo.delete(id);
      this.farSet.delete(id);
      this.placementObjects.delete(id);
    }
    this.pools.get(layerId)?.dispose();
    this.pools.delete(layerId);
    this.dirtyPools.delete(layerId);
    g.removeFromParent();
    this.layerGroups.delete(layerId);
  }

  // --- placements ---

  /** Layer-local anchor position of a placement (no Object3D needed). */
  private localPosition(p: Placement): [number, number, number] {
    if (p.kind === "free") return [p.pos[0], p.pos[1], p.pos[2]];
    const size = this.catalog.get(p.block)?.size ?? [1, 1, 1];
    const rotated = p.dir % 2 === 1;
    const ex = (rotated ? size[2] : size[0]) * CELL[0];
    const ez = (rotated ? size[0] : size[2]) * CELL[2];
    return [
      p.coord[0] * CELL[0] + ex / 2,
      p.coord[1] * CELL[1],
      p.coord[2] * CELL[2] + ez / 2,
    ];
  }

  /** World transform + LOD radii for a layer (built per pass, never cached). */
  private layerXf(layer: Layer): LayerXf {
    const [rx, ry, rz] = layer.transform.rotDeg;
    const q = new Quaternion().setFromEuler(
      new Euler(degToRad(rx), degToRad(ry), degToRad(rz), "YXZ"),
    );
    const near = Math.max(layer.settings.lodDistance ?? 700, 100);
    const far = near * 1.2 + 50;
    return {
      layer,
      q,
      tx: layer.transform.translate[0],
      ty: layer.transform.translate[1],
      tz: layer.transform.translate[2],
      near2: near * near,
      far2: far * far,
    };
  }

  private worldOf(info: LodInfo, xf: LayerXf, out: Vector3): Vector3 {
    out.set(info.lx, info.ly, info.lz).applyQuaternion(xf.q);
    out.x += xf.tx;
    out.y += xf.ty;
    out.z += xf.tz;
    return out;
  }

  private addPlacement(layer: Layer, p: Placement): void {
    this.ensureLayerGroup(layer);
    let ids = this.byBlock.get(p.block);
    if (!ids) this.byBlock.set(p.block, (ids = new Set()));
    ids.add(p.id);

    const [lx, ly, lz] = this.localPosition(p);
    const info: LodInfo = { layerId: layer.id, block: p.block, lx, ly, lz };
    this.lodInfo.set(p.id, info);

    if (this.largeMap) {
      const xf = this.layerXf(layer);
      const wp = this.worldOf(info, xf, new Vector3());
      if (wp.distanceToSquared(this.view.camera.position) > xf.far2) {
        // Far: no Object3D at all — just an entry in the layer's far pool.
        this.geometry.hintPosition?.(p.block, wp.x, wp.y, wp.z);
        this.farSet.add(p.id);
        this.dirtyPools.add(layer.id);
        return;
      }
    }
    this.buildVisual(layer, p);
    if (this.largeMap)
      this.geometry.requestLoad?.(this.catalog.get(p.block), p.block, this.variantOf(p, layer));
  }

  /** Create the individual Object3D for a (near) placement. */
  private buildVisual(layer: Layer, p: Placement): void {
    const group = this.layerGroups.get(layer.id);
    if (!group) return;
    const obj = this.buildObject(p, !this.largeMap, layer);
    if (this.wireframeOn) this.addWireframe(obj);
    obj.userData.placementId = p.id;
    obj.userData.layerId = layer.id;
    obj.userData.blockName = p.block;
    for (const child of obj.children) {
      child.userData.placementId = p.id;
      child.userData.layerId = layer.id;
    }
    group.add(obj);
    this.placementObjects.set(p.id, obj);
  }

  private removePlacement(placementId: string): void {
    const obj = this.placementObjects.get(placementId);
    if (obj) {
      obj.removeFromParent();
      this.placementObjects.delete(placementId);
    }
    const info = this.lodInfo.get(placementId);
    if (info) {
      this.byBlock.get(info.block)?.delete(placementId);
      this.lodInfo.delete(placementId);
      if (this.farSet.delete(placementId)) this.dirtyPools.add(info.layerId);
    }
  }

  /**
   * Which mesh variant a placement shows. In-game only blocks seated on the
   * terrain use the ground variant (no underside); anything elevated, tilted
   * off the terrain, or on a void base uses air — with its concrete bottom.
   */
  variantOf(p: Placement, layer?: Layer): "air" | "ground" {
    if (p.kind !== "block") return "air";
    if (p.coord[1] !== DEFAULT_Y_OFFSET) return "air";
    if (baseTypeOf(this.doc.decorationBase) !== "stadium") return "air";
    if (layer) {
      const { rotDeg, translate } = layer.transform;
      // Pitch/roll or vertical shift lifts blocks off the terrain; yaw doesn't.
      if (rotDeg[0] || rotDeg[2] || translate[1] !== 0) return "air";
    }
    return "ground";
  }

  /** Build the visual for a placement. Shared with tools for ghost previews. */
  buildObject(p: Placement, load = true, layer?: Layer): Object3D {
    const tpl = this.geometry.getTemplate(
      this.catalog.get(p.block),
      p.block,
      load,
      this.variantOf(p, layer),
    );
    const clone = tpl.clone();
    const corner = tpl.userData.anchor === "corner";

    // Shadows make roofs shade their own walls like in-game; skipped on
    // large maps where the shadow pass would be too heavy.
    if (!this.largeMap) {
      clone.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
    }

    // Painted placements: tint the game's colorable surfaces, resolving the
    // stored slot through the map's color palette.
    const paint = (p.meta as { color?: string } | undefined)?.color;
    if (paint && paint !== "Default") {
      const hex = paintHex(this.doc.colorPalette, paint);
      if (hex) this.geometry.colorize?.(clone, hex);
    }

    if (p.kind === "block") {
      const size = (tpl.userData.sizeCells as [number, number, number]) ??
        this.catalog.get(p.block)?.size ?? [1, 1, 1];
      let obj = clone;
      if (corner) {
        obj = new Group();
        clone.position.set((-size[0] * CELL[0]) / 2, 0, (-size[2] * CELL[2]) / 2);
        obj.add(clone);
      }
      const rotated = p.dir % 2 === 1;
      const ex = (rotated ? size[2] : size[0]) * CELL[0];
      const ez = (rotated ? size[0] : size[2]) * CELL[2];
      obj.position.set(
        p.coord[0] * CELL[0] + ex / 2,
        p.coord[1] * CELL[1],
        p.coord[2] * CELL[2] + ez / 2,
      );
      obj.rotation.y = -p.dir * (Math.PI / 2);
      obj.userData.originOffset = [(-size[0] * CELL[0]) / 2, 0, (-size[2] * CELL[2]) / 2];
      return obj;
    }

    clone.position.set(...p.pos);
    clone.rotation.set(p.rot[1], p.rot[0], p.rot[2], "YXZ");
    return clone;
  }

  getObject(placementId: string): Object3D | undefined {
    return this.placementObjects.get(placementId);
  }

  getLayerGroup(layerId: string): Group | undefined {
    return this.layerGroups.get(layerId);
  }

  private lastPalette = "Classic";

  /** Debug: draw polygon edges over the textures (geometry vs texture). */
  private wireframeOn = false;

  setWireframe(on: boolean): void {
    this.wireframeOn = on;
    for (const obj of this.placementObjects.values()) {
      if (on) this.addWireframe(obj);
      else this.removeWireframe(obj);
    }
  }

  private addWireframe(root: Object3D): void {
    const add: Array<() => void> = [];
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh || o.userData.isWire) return;
      if (mesh.children.some((c) => c.userData.isWire)) return;
      add.push(() => {
        const wire = new LineSegments(
          new EdgesGeometry(mesh.geometry, 15),
          new LineBasicMaterial({ color: 0x14d0a4 }),
        );
        wire.userData.isWire = true;
        wire.raycast = () => {};
        mesh.add(wire);
      });
    });
    for (const fn of add) fn();
  }

  private removeWireframe(root: Object3D): void {
    const drop: Object3D[] = [];
    root.traverse((o) => {
      if (o.userData.isWire) drop.push(o);
    });
    for (const o of drop) o.removeFromParent();
  }

  /** Rebuild every painted placement's visual (palette change). */
  private refreshPainted(): void {
    for (const [id, info] of this.lodInfo) {
      if (this.farSet.has(id)) continue;
      const layer = this.doc.getLayer(info.layerId);
      const p = layer?.placements.get(id);
      if (!layer || !p) continue;
      if (!(p.meta as { color?: string } | undefined)?.color) continue;
      const obj = this.placementObjects.get(id);
      if (obj) {
        obj.removeFromParent();
        this.placementObjects.delete(id);
      }
      this.buildVisual(layer, p);
    }
  }

  /** Rebuild the near visuals of one block — e.g. when its real mesh arrives.
   * Far entries stay boxes; they get the mesh when promoted. */
  refreshBlock(blockName: string): void {
    const ids = this.byBlock.get(blockName);
    if (!ids) return;
    for (const id of [...ids]) {
      if (this.farSet.has(id)) continue;
      const info = this.lodInfo.get(id);
      const layer = info ? this.doc.getLayer(info.layerId) : undefined;
      const p = layer?.placements.get(id);
      if (!layer || !p) continue;
      const obj = this.placementObjects.get(id);
      if (obj) {
        obj.removeFromParent();
        this.placementObjects.delete(id);
      }
      this.buildVisual(layer, p);
    }
  }

  /** Nearest placement under the pointer ray, honouring layer visibility. */
  pick(ray: Raycaster): PickResult | null {
    const hits = ray.intersectObject(this.root, true);
    for (const hit of hits) {
      let o: Object3D | null = hit.object;
      while (o && !o.userData.placementId) o = o.parent;
      if (o?.userData.placementId) {
        return {
          layerId: o.userData.layerId,
          placementId: o.userData.placementId,
          object: o,
        };
      }
    }
    return null;
  }

  // --- LOD ---

  private lodTick(): void {
    if (!this.largeMap) return;
    this.frame = (this.frame + 1) % CLASSIFY_EVERY_N_FRAMES;
    if (this.frame === 0) this.classify();
    // Spread pool refills: one dirty layer per frame.
    const next = this.dirtyPools.values().next();
    if (!next.done) {
      this.dirtyPools.delete(next.value);
      this.fillPool(next.value);
    }
  }

  private classify(): void {
    const cam = this.view.camera.position;
    const xfs = new Map<string, LayerXf>();
    for (const layer of this.doc.layers) xfs.set(layer.id, this.layerXf(layer));
    const wp = new Vector3();
    for (const [id, info] of this.lodInfo) {
      const xf = xfs.get(info.layerId);
      if (!xf) continue;
      const d2 = this.worldOf(info, xf, wp).distanceToSquared(cam);
      if (this.farSet.has(id)) {
        if (d2 < xf.near2) this.promote(id, info, wp);
      } else if (d2 > xf.far2) {
        this.demote(id, info);
      }
    }
  }

  /** Far -> near: build the real visual and request its mesh. */
  private promote(id: string, info: LodInfo, worldPos: Vector3): void {
    const layer = this.doc.getLayer(info.layerId);
    const p = layer?.placements.get(id);
    if (!layer || !p) return;
    this.farSet.delete(id);
    this.dirtyPools.add(info.layerId);
    this.buildVisual(layer, p);
    this.geometry.requestLoad?.(this.catalog.get(info.block), info.block, this.variantOf(p, layer));
    this.geometry.hintPosition?.(info.block, worldPos.x, worldPos.y, worldPos.z);
  }

  /** Near -> far: drop the Object3D entirely; the pool box takes over. */
  private demote(id: string, info: LodInfo): void {
    const obj = this.placementObjects.get(id);
    if (obj) {
      obj.removeFromParent();
      this.placementObjects.delete(id);
    }
    this.farSet.add(id);
    this.dirtyPools.add(info.layerId);
  }

  /** Refill one layer's far-box InstancedMesh from scratch. */
  private fillPool(layerId: string): void {
    const layer = this.doc.getLayer(layerId);
    const group = this.layerGroups.get(layerId);
    if (!layer || !group) return;

    const farIds: string[] = [];
    for (const id of this.farSet)
      if (this.lodInfo.get(id)?.layerId === layerId) farIds.push(id);

    let pool = this.pools.get(layerId) ?? null;
    if (pool && pool.instanceMatrix.count < farIds.length) {
      pool.removeFromParent();
      pool.dispose();
      pool = null;
    }
    if (!pool) {
      const capacity = Math.max(64, Math.ceil(farIds.length * 1.3));
      pool = new InstancedMesh(this.poolGeometry, this.poolMaterial, capacity);
      pool.name = "farPool";
      pool.frustumCulled = false;
      pool.raycast = () => {}; // far things are not pickable
      this.pools.set(layerId, pool);
      group.add(pool);
    }

    const m = new Matrix4();
    const q = new Quaternion();
    const e = new Euler();
    const pos = new Vector3();
    const scl = new Vector3();
    const color = new Color();
    let i = 0;
    for (const id of farIds) {
      const p = layer.placements.get(id);
      if (!p) continue;
      const def = this.catalog.get(p.block);
      const size = def?.size ?? [1, 1, 1];
      const [lx, ly, lz] = this.localPosition(p);
      pos.set(lx, ly, lz);
      if (p.kind === "block") {
        q.setFromEuler(e.set(0, -p.dir * (Math.PI / 2), 0));
      } else {
        q.setFromEuler(e.set(p.rot[1], p.rot[0], p.rot[2], "YXZ"));
      }
      scl.set(
        Math.max(size[0] * CELL[0], 4),
        Math.max(size[1] * CELL[1], 4),
        Math.max(size[2] * CELL[2], 4),
      );
      m.compose(pos, q, scl);
      pool.setMatrixAt(i, m);
      color.set(CATEGORY_COLORS[def?.category ?? ""] ?? 0x808890);
      pool.setColorAt(i, color);
      i += 1;
    }
    pool.count = i;
    pool.instanceMatrix.needsUpdate = true;
    if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
  }
}
