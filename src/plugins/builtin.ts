import type { EditorContext, EditorPlugin } from "./api";
import { PlaceTool } from "@tools/PlaceTool";
import { SelectTool } from "@tools/SelectTool";
import { EraseTool } from "@tools/EraseTool";
import { PaintTool } from "@tools/PaintTool";
import { createPalettePanel } from "@ui/PalettePanel";
import { createLayersPanel } from "@ui/LayersPanel";

/**
 * Everything the stock editor ships with, expressed as plugins against the
 * public API — the same surface third-party plugins will use.
 */

export const toolsPlugin: EditorPlugin = {
  id: "builtin.tools",
  name: "Standard tools",
  init(ctx: EditorContext): void {
    ctx.tools.register(new PlaceTool(ctx));
    ctx.tools.register(new SelectTool(ctx));
    ctx.tools.register(new EraseTool(ctx));
    ctx.tools.register(new PaintTool(ctx));
    ctx.tools.setActive("place");
  },
};

export const palettePlugin: EditorPlugin = {
  id: "builtin.palette",
  name: "Block palette",
  init(ctx: EditorContext): void {
    ctx.ui.registerPanel({
      id: "palette",
      title: "",
      side: "left",
      order: 10,
      element: createPalettePanel(ctx),
    });
  },
};

export const layersPlugin: EditorPlugin = {
  id: "builtin.layers",
  name: "Layers",
  init(ctx: EditorContext): void {
    ctx.ui.registerPanel({
      id: "layers",
      title: "Layers",
      side: "right",
      order: 10,
      element: createLayersPanel(ctx),
    });
  },
};

export const statusPlugin: EditorPlugin = {
  id: "builtin.status",
  name: "Status readouts",
  init(ctx: EditorContext): void {
    ctx.tools.events.on("buildLevelChanged", ({ level }) => {
      ctx.ui.setStatus(`Build level: ${level} (${level * 8} m)`);
    });
    ctx.events.on("status", ({ text }) => ctx.ui.setStatus(text));
  },
};

import { heightGuidePlugin } from "./heightGuide";
import { instrumentationPlugin } from "./instrumentation";

export const builtinPlugins = [
  toolsPlugin,
  palettePlugin,
  layersPlugin,
  statusPlugin,
  heightGuidePlugin,
  instrumentationPlugin,
];
