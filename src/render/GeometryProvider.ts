import type { Object3D } from "three";
import type { BlockDef } from "@core/catalog";
import type { BlockClipInfo } from "./clipAdjacency";

/**
 * Source of renderable geometry for catalog entries.
 *
 * The MVP ships a placeholder implementation (footprint-sized boxes); a future
 * provider will serve real meshes extracted from the game's pak files
 * (GBX.NET.PAK -> CPlugSolid -> glTF). The editor depends only on this
 * interface, so swapping providers is a one-line change in main.ts — and
 * plugins can wrap or replace it.
 */
export interface GeometryProvider {
  /**
   * Returns a template Object3D for the block; callers clone it per
   * placement. `load: false` returns whatever is available (cached real mesh
   * or placeholder) without requesting anything — large maps stream real
   * meshes in by camera proximity instead (see DocumentRenderer).
   */
  getTemplate(
    def: BlockDef | undefined,
    name: string,
    load?: boolean,
    variant?: "air" | "ground",
  ): Object3D;

  /**
   * A block's unit layout and the clips on each unit face, for the chosen
   * variant — what the renderer needs to hide caps joined to a neighbour
   * (see render/clipAdjacency). Undefined when the provider has no such
   * knowledge (placeholders, unknown blocks).
   */
  blockClips?(name: string, variant: "air" | "ground"): BlockClipInfo | undefined;
}
