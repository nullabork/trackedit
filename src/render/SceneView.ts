import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  LineBasicMaterial,
  LineLoop,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { CELL, MAP_SIZE } from "@core/math";
import { CameraRig } from "./CameraRig";
import { applySky } from "./sky";

/**
 * Owns the WebGL canvas, camera rig, lights and the base grid. Knows nothing
 * about the document — DocumentRenderer adds content into `scene`.
 */
/**
 * Editor-only render preferences (how the viewport draws, never map data):
 * skybox as the mood photo or a flat color, lighting as time-of-day mood
 * (tinted sun + shadows) or flat white (even illumination, no shadows).
 */
export interface RenderPrefs {
  sky: "image" | "color";
  skyColor: string;
  lighting: "mood" | "flat";
}

export const DEFAULT_RENDER_PREFS: RenderPrefs = {
  sky: "image",
  skyColor: "#d8e8f6",
  lighting: "mood",
};

/** Lighting presets per mood; the matching skybox is painted in sky.ts
 *  (its sun/moon glow uses these sunDir values, keep them in sync). */
const MOODS_PRESETS: Record<string, { sun: number; sunIntensity: number; sunDir: [number, number, number]; ambient: number; ambientIntensity: number }> = {
  Day: { sun: 0xffffff, sunIntensity: 2.2, sunDir: [0.6, 1, 0.35], ambient: 0x8fa3bd, ambientIntensity: 1.1 },
  Sunrise: { sun: 0xffc9a0, sunIntensity: 1.9, sunDir: [1, 0.35, 0.2], ambient: 0x9a8fb0, ambientIntensity: 0.9 },
  Sunset: { sun: 0xff9a66, sunIntensity: 1.8, sunDir: [-1, 0.3, -0.25], ambient: 0xb08f9a, ambientIntensity: 0.9 },
  Night: { sun: 0x9fb8ff, sunIntensity: 1.0, sunDir: [0.3, 1, 0.5], ambient: 0x3a4a66, ambientIntensity: 0.8 },
};

export class SceneView {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly rig: CameraRig;
  private raycaster = new Raycaster();
  private frameCallbacks: Array<() => void> = [];
  private sun: DirectionalLight;
  private ambient: AmbientLight;
  private grid: GridHelper | null = null;
  private baseBounds: LineLoop | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new Color(0x1a2129);

    const worldW = MAP_SIZE[0] * CELL[0];
    const worldD = MAP_SIZE[2] * CELL[2];

    this.camera = new PerspectiveCamera(55, 1, 1, 40000);
    this.rig = new CameraRig(this.camera, canvas);
    this.rig.lookAt(new Vector3(worldW / 2, 40, worldD / 2), 1400, Math.PI * 0.82, -0.62);

    this.sun = new DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(0.6, 1, 0.35).multiplyScalar(1200);
    this.ambient = new AmbientLight(0x8fa3bd, 1.1);
    this.scene.add(this.sun, this.sun.target, this.ambient);

    // Shadows sell the in-game look (wall faces sit in their roofs'
    // shade). Large maps turn casting off per-object (see setShadows).
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const cam = this.sun.shadow.camera;
    cam.near = 100;
    cam.far = 6000;
    cam.left = cam.bottom = -1400;
    cam.right = cam.top = 1400;
    this.sun.shadow.bias = -0.0005;

    this.setMapSize(MAP_SIZE);

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // setSize clears the drawing buffer — repaint NOW, not on the next
      // RAF, or panel slide animations flash black frames.
      this.renderer.render(this.scene, this.camera);
    };
    new ResizeObserver(resize).observe(canvas.parentElement ?? canvas);
    resize();

    let last = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      this.rig.update(dt);
      for (const fn of this.frameCallbacks) fn();
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(loop);
  }

  onFrame(fn: () => void): void {
    this.frameCallbacks.push(fn);
  }

  /**
   * Render synchronously and return the frame as a PNG data URL. WebGL
   * buffers are cleared after presentation, so the render and the read
   * must happen in the same task — hence not just toDataURL().
   */
  captureFrame(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  /**
   * Map size changed. Grid lines are per-layer now (DocumentRenderer);
   * here we keep the fixed BASE BOUNDS marker: a green rectangle at world
   * y=0 outlining the map footprint — the build lower limit. It never
   * rotates or translates with layers.
   */
  setMapSize(size: readonly [number, number, number]): void {
    this.grid?.removeFromParent();
    this.grid = null;
    this.baseBounds?.removeFromParent();
    const w = size[0] * CELL[0];
    const d = size[2] * CELL[2];
    const line = new LineLoop(
      new BufferGeometry().setFromPoints([
        new Vector3(0, 0, 0),
        new Vector3(w, 0, 0),
        new Vector3(w, 0, d),
        new Vector3(0, 0, d),
      ]),
      new LineBasicMaterial({ color: 0x35d07f, transparent: true, opacity: 0.9 }),
    );
    line.name = "baseBounds";
    line.raycast = () => {};
    this.baseBounds = line;
    this.scene.add(line);
  }

  private skyToken = 0;
  private prefs: RenderPrefs = { ...DEFAULT_RENDER_PREFS };
  private lastMood = "Day";
  private lastBase: "stadium" | "void" = "stadium";

  getRenderPrefs(): RenderPrefs {
    return { ...this.prefs };
  }

  /** Editor-only view preferences; re-applies the current ambience. */
  setRenderPrefs(prefs: RenderPrefs): void {
    this.prefs = { ...prefs };
    this.setAmbience(this.lastMood, this.lastBase);
  }

  /** Mood lighting + the skybox (dimmed for void/no-stadium bases),
   *  filtered through the editor render prefs (solid sky / flat light). */
  setAmbience(mood: string, baseType: "stadium" | "void"): void {
    this.lastMood = mood;
    this.lastBase = baseType;
    const p = MOODS_PRESETS[mood] ?? MOODS_PRESETS.Day;
    // applySky calls back twice (procedural now, photo when loaded) — the
    // token drops the late photo if the mood/prefs changed again meanwhile.
    const token = ++this.skyToken;
    if (this.prefs.sky === "color") {
      this.scene.background = new Color(this.prefs.skyColor);
    } else {
      applySky(mood, (tex) => {
        if (this.skyToken === token) this.scene.background = tex;
      });
    }
    this.scene.backgroundIntensity = baseType === "void" ? 0.45 : 1;
    if (this.prefs.lighting === "flat") {
      // Even white studio light: no mood tint, no shadows.
      this.sun.color.set(0xffffff);
      this.sun.intensity = 1.0;
      this.sun.castShadow = false;
      this.ambient.color.set(0xffffff);
      this.ambient.intensity = 1.5;
    } else {
      this.sun.color.set(p.sun);
      this.sun.intensity = p.sunIntensity;
      this.sun.castShadow = true;
      this.ambient.color.set(p.ambient);
      this.ambient.intensity = p.ambientIntensity;
    }
    this.sun.position.set(...p.sunDir).multiplyScalar(1200);
  }

  /** Ray from a pointer event, in normalized device coords. */
  rayFromEvent(ev: PointerEvent): Raycaster {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  /** Intersection of the pointer ray with the horizontal plane at `y` metres. */
  hitPlaneY(ray: Raycaster, y: number): Vector3 | null {
    const origin = ray.ray.origin;
    const dir = ray.ray.direction;
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = (y - origin.y) / dir.y;
    if (t < 0) return null;
    return new Vector3().copy(dir).multiplyScalar(t).add(origin);
  }
}
