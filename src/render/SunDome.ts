import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Ray,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import type { Vec3 } from "@core/math";
import { SUNRISE01, SUNSET01, sunDirection } from "@core/sun";
import { directionFrom } from "@core/atmosphere";

const RING_STEP = 15;
const MERIDIANS = 24;

/**
 * The sky as a giant dome around the map: height rings every 15 degrees,
 * compass letters on the horizon, the sun's path for the day, and two
 * handles — the sun, and the moon opposite it. Editor-only helper, shown
 * while the sun tool is active.
 */
export class SunDome {
  readonly group = new Group();
  private readonly sun: Mesh;
  private readonly moon: Mesh;
  private readonly arc: Line;
  private centre = new Vector3();

  constructor(private radius: number) {
    this.group.name = "sunDome";
    this.group.visible = false;
    const points: number[] = [];
    const push = (heading: number, altitude: number) => {
      const d = directionFrom(heading, altitude);
      points.push(d[0], d[1], d[2]);
    };
    for (let alt = RING_STEP; alt < 90; alt += RING_STEP)
      for (let i = 0; i < 96; i++) {
        push((i / 96) * 360, alt);
        push(((i + 1) / 96) * 360, alt);
      }
    for (let m = 0; m < MERIDIANS; m++)
      for (let alt = 0; alt < 90; alt += 5) {
        push((m / MERIDIANS) * 360, alt);
        push((m / MERIDIANS) * 360, alt + 5);
      }
    this.group.add(this.lines(points, 0x9fb1bf, 0.28));

    const horizon: number[] = [];
    for (let i = 0; i < 128; i++) {
      const a = directionFrom((i / 128) * 360, 0), b = directionFrom(((i + 1) / 128) * 360, 0);
      horizon.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    this.group.add(this.lines(horizon, 0xffc83c, 0.8));

    for (const [label, heading] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as const) {
      const sprite = new Sprite(new SpriteMaterial({ map: letter(label), depthTest: false, fog: false, transparent: true }));
      const d = directionFrom(heading, 3);
      sprite.position.set(d[0], d[1], d[2]);
      sprite.scale.setScalar(0.09);
      sprite.raycast = () => {};
      this.group.add(sprite);
    }

    this.arc = new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0xff8c1a, transparent: true, opacity: 0.9, fog: false }));
    this.arc.raycast = () => {};
    this.group.add(this.arc);

    const handle = (size: number) => {
      const mesh = new Mesh(new SphereGeometry(size, 24, 16), new MeshBasicMaterial({ depthTest: false, fog: false, transparent: true }));
      mesh.renderOrder = 999;
      mesh.raycast = () => {};
      return mesh;
    };
    this.sun = handle(0.04);
    this.moon = handle(0.025);
    this.group.add(this.sun, this.moon);
    this.group.scale.setScalar(radius);
  }

  private lines(points: number[], color: number, opacity: number): LineSegments {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(points, 3));
    const seg = new LineSegments(geo, new LineBasicMaterial({ color, transparent: true, opacity, fog: false }));
    seg.raycast = () => {};
    return seg;
  }

  setFrame(centre: Vector3, radius: number): void {
    this.centre.copy(centre);
    this.radius = radius;
    this.group.position.copy(centre);
    this.group.scale.setScalar(radius);
  }

  /** Move the handles and redraw the day's path for this latitude. */
  setSun(dir: Vec3, latitude: number, sunColor: string, moonColor: string): void {
    this.sun.position.set(dir[0], dir[1], dir[2]);
    this.moon.position.set(-dir[0], -dir[1], -dir[2]);
    (this.sun.material as MeshBasicMaterial).color = new Color(sunColor);
    (this.moon.material as MeshBasicMaterial).color = new Color(moonColor);
    const path: number[] = [];
    for (let i = 0; i <= 64; i++) {
      const d = sunDirection({ dayTime01: SUNRISE01 + (i / 64) * (SUNSET01 - SUNRISE01), latitude });
      path.push(d[0], d[1], d[2]);
    }
    this.arc.geometry.setAttribute("position", new Float32BufferAttribute(path, 3));
    this.arc.geometry.computeBoundingSphere();
  }

  /**
   * The point of the dome under the pointer, as a direction from the map's
   * centre. A ray can cross the dome twice; the crossing nearest the current
   * sun wins, so a drag never jumps to the far side. Crossings below the
   * horizon are lifted onto it.
   */
  pick(ray: Ray, current: Vec3): Vec3 | null {
    const o = ray.origin.clone().sub(this.centre);
    const b = o.dot(ray.direction);
    const disc = b * b - (o.lengthSq() - this.radius * this.radius);
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    let best: Vector3 | null = null;
    let bestDot = -Infinity;
    for (const t of [-b - root, -b + root]) {
      if (t <= 0) continue;
      const p = o.clone().addScaledVector(ray.direction, t).normalize();
      if (p.y < 0) {
        p.y = 0;
        if (p.lengthSq() === 0) continue;
        p.normalize();
      }
      const dot = p.x * current[0] + p.y * current[1] + p.z * current[2];
      if (dot > bestDot) {
        bestDot = dot;
        best = p;
      }
    }
    return best ? [best.x, best.y, best.z] : null;
  }
}

function letter(text: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 44px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffc83c";
  ctx.fillText(text, 32, 34);
  return new CanvasTexture(canvas);
}
