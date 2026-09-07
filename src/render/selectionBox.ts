import {
  Box3,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  CircleGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import type { Raycaster } from "three";

/** Colours the selection box reads from the render prefs. */
export interface SelectionColors {
  selectionColor: string;
  axisX: string;
  axisY: string;
  axisZ: string;
}

const AXES = ["x", "y", "z"] as const;
export type Axis = (typeof AXES)[number];

/**
 * Selection outline: the bounding box in the selection colour, except the
 * three edges leaving the min corner, which are drawn in the X, Y and Z
 * axis colours with a camera-facing tag at their far end naming the axis.
 * Everything renders on top of the scene (no depth test, late render
 * order) and is unpickable.
 */
export class SelectionBox extends Group {
  private readonly frame: LineSegments;
  private readonly axisLines: Record<Axis, LineSegments>;
  private readonly tags: Record<Axis, Sprite>;
  /** Rotate handles: a solid disc beside each tag, lying in the plane it turns. */
  private readonly rings: Record<Axis, Mesh>;
  private readonly box = new Box3();

  constructor(colors: SelectionColors) {
    super();
    this.name = "selectionBox";
    this.renderOrder = 1000;
    const line = (color: string) => {
      const geom = new BufferGeometry();
      geom.setAttribute("position", new Float32BufferAttribute(new Float32Array(2 * 12 * 3), 3));
      const l = new LineSegments(geom, new LineBasicMaterial({ color, depthTest: false, transparent: true }));
      l.renderOrder = 1000;
      l.raycast = () => {};
      l.frustumCulled = false;
      this.add(l);
      return l;
    };
    this.frame = line(colors.selectionColor);
    this.axisLines = { x: line(colors.axisX), y: line(colors.axisY), z: line(colors.axisZ) };
    const tag = (axis: Axis, color: string) => {
      const s = new Sprite(new SpriteMaterial({ map: tagTexture(axis, color), depthTest: false, transparent: true }));
      s.renderOrder = 1001;
      // Tags stay pickable: dragging one moves the selection along its axis.
      s.userData.axis = axis;
      s.scale.set(3, 3, 1);
      this.add(s);
      return s;
    };
    this.tags = { x: tag("x", colors.axisX), y: tag("y", colors.axisY), z: tag("z", colors.axisZ) };
    const ring = (axis: Axis, color: string) => {
      const m = new Mesh(new CircleGeometry(1, 40),
        new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9, side: DoubleSide }));
      m.renderOrder = 1002;
      m.userData.ring = axis;
      // Plane of rotation: X disc turns in XY (about Z), Y disc in XZ (about
      // Y), Z disc in ZY (about X). A circle lies in XY by default.
      if (axis === "y") m.rotation.x = Math.PI / 2;
      if (axis === "z") m.rotation.y = Math.PI / 2;
      this.add(m);
      return m;
    };
    this.rings = { x: ring("x", colors.axisX), y: ring("y", colors.axisY), z: ring("z", colors.axisZ) };
  }

  /** Which axis a ring spins about: X ring about Z, Y ring about Y, Z ring about X. */
  static rotationAxisOf(ring: Axis): Axis {
    return ring === "x" ? "z" : ring === "z" ? "x" : "y";
  }

  /** The rotate ring under a pointer ray, if any. */
  hitRing(ray: Raycaster): Axis | null {
    const hit = ray.intersectObjects(AXES.map((a) => this.rings[a]), false)[0];
    return (hit?.object.userData.ring as Axis | undefined) ?? null;
  }

  setColors(colors: SelectionColors): void {
    (this.frame.material as LineBasicMaterial).color.set(colors.selectionColor);
    for (const a of AXES) {
      const c = colors[`axis${a.toUpperCase()}` as keyof SelectionColors];
      (this.axisLines[a].material as LineBasicMaterial).color.set(c);
      (this.rings[a].material as MeshBasicMaterial).color.set(c);
      const mat = this.tags[a].material as SpriteMaterial;
      mat.map?.dispose();
      mat.map = tagTexture(a, c);
      mat.needsUpdate = true;
    }
  }

  /** Fit to a box (world space). */
  setBox(box: Box3): void {
    if (this.box.equals(box)) return;
    this.box.copy(box);
    const { min, max } = box;
    const c = (x: number, y: number, z: number) => [x, y, z];
    // Edges not touching the min corner's three axis edges.
    const frame = [
      c(max.x, min.y, min.z), c(max.x, max.y, min.z),
      c(max.x, min.y, min.z), c(max.x, min.y, max.z),
      c(min.x, max.y, min.z), c(max.x, max.y, min.z),
      c(min.x, max.y, min.z), c(min.x, max.y, max.z),
      c(min.x, min.y, max.z), c(max.x, min.y, max.z),
      c(min.x, min.y, max.z), c(min.x, max.y, max.z),
      c(max.x, max.y, min.z), c(max.x, max.y, max.z),
      c(max.x, min.y, max.z), c(max.x, max.y, max.z),
      c(min.x, max.y, max.z), c(max.x, max.y, max.z),
    ].flat();
    setLine(this.frame, frame);
    setLine(this.axisLines.x, [...c(min.x, min.y, min.z), ...c(max.x, min.y, min.z)]);
    setLine(this.axisLines.y, [...c(min.x, min.y, min.z), ...c(min.x, max.y, min.z)]);
    setLine(this.axisLines.z, [...c(min.x, min.y, min.z), ...c(min.x, min.y, max.z)]);
    // Tags sit just past the end of each axis edge.
    const pad = 2.2;
    this.tags.x.position.set(max.x + pad, min.y, min.z);
    this.tags.y.position.set(min.x, max.y + pad, min.z);
    this.tags.z.position.set(min.x, min.y, max.z + pad);
  }

  /** The axis tag under a pointer ray, if any (sprites need the camera on the ray). */
  hitTag(ray: Raycaster): Axis | null {
    const hit = ray.intersectObjects(AXES.map((a) => this.tags[a]), false)[0];
    return (hit?.object.userData.axis as Axis | undefined) ?? null;
  }

  /** Keep tags and rings a readable size at any distance (sprites face the camera anyway). */
  updateForCamera(cameraPos: Vector3): void {
    for (const a of AXES) {
      const s = this.tags[a];
      const size = Math.max(2.5, s.position.distanceTo(cameraPos) * 0.025);
      s.scale.set(size, size, 1);
      // Ring just past the tag along its axis.
      const r = this.rings[a];
      const dir = a === "x" ? [1, 0, 0] : a === "y" ? [0, 1, 0] : [0, 0, 1];
      r.position.set(
        s.position.x + dir[0] * size * 1.1,
        s.position.y + dir[1] * size * 1.1,
        s.position.z + dir[2] * size * 1.1);
      const rs = size * 0.4;
      r.scale.set(rs, rs, rs);
    }
  }

  dispose(): void {
    this.frame.geometry.dispose();
    (this.frame.material as LineBasicMaterial).dispose();
    for (const a of AXES) {
      this.axisLines[a].geometry.dispose();
      (this.axisLines[a].material as LineBasicMaterial).dispose();
      const mat = this.tags[a].material as SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.rings[a].geometry.dispose();
      (this.rings[a].material as MeshBasicMaterial).dispose();
    }
  }
}

function setLine(line: LineSegments, coords: number[]): void {
  const attr = line.geometry.getAttribute("position") as Float32BufferAttribute;
  (attr.array as Float32Array).fill(0);
  (attr.array as Float32Array).set(coords);
  line.geometry.setDrawRange(0, coords.length / 3);
  attr.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

/** A rounded label: axis colour background, dark letter. */
function tagTexture(axis: Axis, color: string): CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  const bg = new Color(color);
  if (!g) return new CanvasTexture(canvas); // no 2D context (tests): blank tag
  g.fillStyle = `#${bg.getHexString()}`;
  const r = 14;
  g.beginPath();
  if (typeof g.roundRect === "function") g.roundRect(4, 4, size - 8, size - 8, r);
  else g.rect(4, 4, size - 8, size - 8);
  g.fill();
  g.fillStyle = luminance(bg) > 0.5 ? "#101418" : "#ffffff";
  g.font = "bold 40px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(axis.toUpperCase(), size / 2, size / 2 + 2);
  const tex = new CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function luminance(c: Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}
