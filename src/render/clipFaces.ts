import { CELL, quatFromGameRot, quatRotate } from "@core/math";
import type { Vec3 } from "@core/math";
import { FACE_NORMAL, clipHiddenBy, clipPartName, rotateByDir, unitCell } from "./clipAdjacency";
import type { BlockClipInfo, GridPose, UnitClip } from "./clipAdjacency";

/**
 * Clip joining for FREE blocks — and between free and grid blocks.
 *
 * Grid blocks find the clip facing theirs by cell (clipAdjacency). A free
 * block has no cell, but the game joins its clips all the same: the map file's
 * baked clips of four free "expandable gate" blocks laid side by side hold one
 * post at each end, not eight. What the two cases share is geometry: two clips
 * face each other when the CENTRES of their unit faces coincide and their
 * outward normals are opposite. For grid blocks that is exactly the cell rule;
 * for free blocks it is what snapping them together produces.
 *
 * Everything here is in layer-local metres (a grid cell [x,y,z] spans
 * x*32..(x+1)*32, y*8..(y+1)*8, z*32..(z+1)*32 — the frame free positions use).
 */
export interface ClipFace {
  /** Which placement carries it. */
  owner: string;
  clip: UnitClip;
  centre: Vec3;
  normal: Vec3;
}

const HALF: Vec3 = [CELL[0] / 2, CELL[1] / 2, CELL[2] / 2];

/** The clip faces of a free block: `pos` is its origin corner, `rot` the game's yaw/pitch/roll. */
export function freeClipFaces(owner: string, pos: Vec3, rot: Vec3, info: BlockClipInfo): ClipFace[] {
  const q = quatFromGameRot(rot);
  return info.clips.map((clip) => {
    const n = FACE_NORMAL[clip.face];
    const local: Vec3 = [
      (clip.u[0] + 0.5) * CELL[0] + n[0] * HALF[0],
      (clip.u[1] + 0.5) * CELL[1] + n[1] * HALF[1],
      (clip.u[2] + 0.5) * CELL[2] + n[2] * HALF[2],
    ];
    const w = quatRotate(q, local);
    return { owner, clip, centre: [pos[0] + w[0], pos[1] + w[1], pos[2] + w[2]], normal: quatRotate(q, [n[0], n[1], n[2]]) };
  });
}

/** The clip faces of a grid block, in the same frame. */
export function gridClipFaces(owner: string, pose: GridPose, info: BlockClipInfo): ClipFace[] {
  return info.clips.map((clip) => {
    const cell = unitCell(pose, info.size, clip.u);
    const n = rotateByDir(FACE_NORMAL[clip.face], pose.dir);
    return {
      owner, clip,
      centre: [(cell[0] + 0.5) * CELL[0] + n[0] * HALF[0], (cell[1] + 0.5) * CELL[1] + n[1] * HALF[1], (cell[2] + 0.5) * CELL[2] + n[2] * HALF[2]],
      normal: [n[0], n[1], n[2]],
    };
  });
}

/** Faces by position, for finding the ones that coincide with a given face. */
export class ClipFaceIndex {
  private readonly buckets = new Map<string, ClipFace[]>();
  /** Free blocks are snapped, not computed: allow this much slack (metres). */
  static readonly TOLERANCE = 0.5;

  private static key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  add(face: ClipFace): void {
    const k = ClipFaceIndex.key(Math.round(face.centre[0]), Math.round(face.centre[1]), Math.round(face.centre[2]));
    (this.buckets.get(k) ?? this.buckets.set(k, []).get(k)!).push(face);
  }

  remove(owner: string, faces: readonly ClipFace[]): void {
    for (const f of faces) {
      const k = ClipFaceIndex.key(Math.round(f.centre[0]), Math.round(f.centre[1]), Math.round(f.centre[2]));
      const left = (this.buckets.get(k) ?? []).filter((o) => o.owner !== owner);
      if (left.length) this.buckets.set(k, left);
      else this.buckets.delete(k);
    }
  }

  /** Faces of OTHER placements that look straight back at `face` from the same spot. */
  facing(face: ClipFace): ClipFace[] {
    const out: ClipFace[] = [];
    const [cx, cy, cz] = [Math.round(face.centre[0]), Math.round(face.centre[1]), Math.round(face.centre[2])];
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++) {
      for (const o of this.buckets.get(ClipFaceIndex.key(x, y, z)) ?? []) {
        if (o.owner === face.owner) continue;
        const d = Math.hypot(o.centre[0] - face.centre[0], o.centre[1] - face.centre[1], o.centre[2] - face.centre[2]);
        const dot = o.normal[0] * face.normal[0] + o.normal[1] * face.normal[1] + o.normal[2] * face.normal[2];
        if (d <= ClipFaceIndex.TOLERANCE && dot < -0.99) out.push(o);
      }
    }
    return out;
  }
}

/** Names of the clip parts of one placement that a facing clip hides. */
export function hiddenClipFaces(faces: readonly ClipFace[], index: ClipFaceIndex): Set<string> {
  const hidden = new Set<string>();
  for (const f of faces) if (index.facing(f).some((o) => clipHiddenBy(f.clip, o.clip))) hidden.add(clipPartName(f.clip));
  return hidden;
}
