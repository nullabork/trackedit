import { Box3, Box3Helper, Color } from "three";
import type { EditorContext, EditorPlugin } from "./api";

const GREEN = new Color(0x35d07f);
const MAX_HIGHLIGHTS = 400;

/**
 * While placing, outlines everything on the active layer that sits at the
 * current build height in green — instant feedback that you're at the right
 * level before you click. Implemented as a plugin on the public API.
 */
export const heightGuidePlugin: EditorPlugin = {
  id: "builtin.heightGuide",
  name: "Build-height guide",
  init(ctx: EditorContext): void {
    const helpers: Box3Helper[] = [];

    const clear = () => {
      for (const h of helpers) h.removeFromParent();
      helpers.length = 0;
    };

    const rebuild = () => {
      clear();
      if (ctx.tools.activeTool?.id !== "place") return;
      const layer = ctx.document.activeLayer;
      if (!layer.visible) return;
      const level = ctx.tools.buildLevel;
      const stepY = layer.settings.gridStep[1];

      ctx.renderer.getLayerGroup(layer.id)?.updateMatrixWorld(true);
      for (const p of layer.placements.values()) {
        const atLevel = p.kind === "block"
          ? p.coord[1] === level
          : p.pos[1] >= level * stepY && p.pos[1] < (level + 1) * stepY;
        if (!atLevel) continue;
        const obj = ctx.renderer.getObject(p.id);
        if (!obj) continue;
        const helper = new Box3Helper(new Box3().setFromObject(obj), GREEN);
        helper.raycast = () => {};
        ctx.view.scene.add(helper);
        helpers.push(helper);
        if (helpers.length >= MAX_HIGHLIGHTS) break;
      }
    };

    ctx.tools.events.on("buildLevelChanged", rebuild);
    ctx.tools.events.on("activeChanged", rebuild);
    ctx.document.events.on("placementAdded", rebuild);
    ctx.document.events.on("placementRemoved", rebuild);
    ctx.document.events.on("layerChanged", rebuild);
    ctx.document.events.on("activeLayerChanged", rebuild);
    ctx.document.events.on("reset", rebuild);
    rebuild();
  },
};
