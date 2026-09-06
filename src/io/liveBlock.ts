import type { MapDocument } from "@core/document";
import { isIdentityTransform } from "@core/layer";
import type { SelectionEntry } from "@core/selection";

export interface LiveBlock {
  name: string;
  coord: number[];
  dir: number;
  isGround: boolean;
}

/** First live milestone: one ordinary grid block, in game grid coordinates. */
export function selectedLiveBlock(doc: MapDocument, selection: readonly SelectionEntry[]): LiveBlock {
  if (selection.length !== 1) throw new Error("Select exactly one grid block in the editor first.");
  const { layerId, placementId } = selection[0];
  const layer = doc.getLayer(layerId);
  const p = layer?.placements.get(placementId);
  if (!layer || !p) throw new Error("The selected block no longer exists.");
  if (p.kind !== "block") throw new Error("This first version supports grid blocks only.");
  if (!isIdentityTransform(layer.transform)) throw new Error("Use a block on a layer with no translation or rotation.");
  if (p.meta?.isGhost) throw new Error("Ghost blocks are not supported yet.");
  return { name: p.block, coord: [...p.coord], dir: p.dir, isGround: p.meta?.isGround === true };
}
