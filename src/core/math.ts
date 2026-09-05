/** Pure math/domain types. No DOM, no three.js. */

export type Vec3 = readonly [number, number, number];
export type GridCoord = readonly [number, number, number];
/** Quarter-turn direction, matches Map.Gbx block `dir` (0..3, clockwise). */
export type Dir = 0 | 1 | 2 | 3;

/** Size of one grid cell in metres (x, y, z). */
export const CELL: Vec3 = [32, 8, 32];
/** Default Stadium 48x48 map size in cells (x, y, z). */
export const MAP_SIZE: GridCoord = [48, 40, 48];
/**
 * Vertical grid-origin shift, in cells, applied by the common 48x48
 * decorations when converting grid coords to world metres.
 */
export const DEFAULT_Y_OFFSET = 8;

export const DIRS: readonly Dir[] = [0, 1, 2, 3];

export function rotateDir(dir: Dir, quarterTurns: number): Dir {
  return (((dir + quarterTurns) % 4) + 4) % 4 as Dir;
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function coordEquals(a: GridCoord, b: GridCoord): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function coordKey(c: GridCoord): string {
  return `${c[0]},${c[1]},${c[2]}`;
}

export function clampCoord(c: GridCoord, size: GridCoord = MAP_SIZE): GridCoord {
  return [
    Math.min(Math.max(c[0], 0), size[0] - 1),
    Math.min(Math.max(c[1], 0), size[1] - 1),
    Math.min(Math.max(c[2], 0), size[2] - 1),
  ];
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Minimal quaternion math so io/ can bake full layer rotations without
 * depending on three.js. Conventions match three: [x, y, z, w], Euler order
 * "YXZ" (yaw, pitch, roll — the game's yawPitchRoll maps to [y, x, z]).
 */
export type Quat = readonly [number, number, number, number];

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function quatFromAxisAngle(axis: Vec3, rad: number): Quat {
  const h = rad / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Euler YXZ (radians, [x, y, z]) -> quaternion; matches three.js. */
export function quatFromEulerYXZ(e: Vec3): Quat {
  const qy = quatFromAxisAngle([0, 1, 0], e[1]);
  const qx = quatFromAxisAngle([1, 0, 0], e[0]);
  const qz = quatFromAxisAngle([0, 0, 1], e[2]);
  return quatMul(quatMul(qy, qx), qz);
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 * (q.xyz × v); v' = v + w*t + q.xyz × t
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + qy * tz - qz * ty,
    v[1] + qw * ty + qz * tx - qx * tz,
    v[2] + qw * tz + qx * ty - qy * tx,
  ];
}

/** Quaternion -> Euler YXZ (radians, [x, y, z]); matches three.js. */
export function eulerYXZFromQuat(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const m13 = 2 * (x * z + y * w);
  const m23 = 2 * (y * z - x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const m21 = 2 * (x * y + z * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m11 = 1 - 2 * (y * y + z * z);
  const m31 = 2 * (x * z - y * w);
  const ex = Math.asin(-Math.min(Math.max(m23, -1), 1));
  if (Math.abs(m23) < 0.9999999)
    return [ex, Math.atan2(m13, m33), Math.atan2(m21, m22)];
  return [ex, Math.atan2(-m31, m11), 0];
}

let idCounter = 0;
/** Monotonic, collision-free within a session; prefixed for readability. */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
