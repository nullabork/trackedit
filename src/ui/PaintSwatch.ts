import type { EditorContext } from "@plugins/api";
import type { PaintTool, PaintColor } from "@tools/PaintTool";
import { PAINTABLE } from "@tools/PaintTool";
import { PALETTES, PALETTE_NAMES, paintHex } from "@core/palettes";
import { el, clear } from "./dom";

/**
 * Floating paint bar (bottom centre of the viewport, visible while the
 * paint tool is active): palette picker + the five slot chips rendered in
 * the map's current palette, plus Default (un-paint).
 */
export function mountPaintSwatch(ctx: EditorContext, viewportWrap: HTMLElement): void {
  const bar = el("div", { class: "paint-swatch" });
  bar.style.display = "none";
  viewportWrap.append(bar);

  const tool = () => ctx.tools.all.find((t) => t.id === "paint") as PaintTool | undefined;

  const render = () => {
    clear(bar);
    const palette = ctx.document.colorPalette;
    const active = tool()?.color ?? "White";

    const select = el("select", { class: "palette-select", title: "Color palette" });
    for (const name of PALETTE_NAMES) {
      const opt = el("option", { value: name }, name) as HTMLOptionElement;
      if (name === palette) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      ctx.document.setColorPalette((select as HTMLSelectElement).value);
      render();
    });
    bar.append(select);

    for (const slot of PAINTABLE) {
      const hex = slot === "Default" ? null : paintHex(palette, slot);
      const chip = el("button", {
        class: `paint-chip${slot === active ? " active" : ""}${hex ? "" : " none"}`,
        title: slot === "Default" ? "Default (un-paint)" : slot,
      });
      if (hex) chip.style.background = hex;
      chip.addEventListener("click", () => {
        tool()?.setColor(slot as PaintColor);
        render();
      });
      bar.append(chip);
    }
  };

  ctx.tools.events.on("activeChanged", ({ tool: t }) => {
    bar.style.display = t?.id === "paint" ? "" : "none";
    if (t?.id === "paint") render();
  });
  ctx.events.on("paintColorChanged", render);
  ctx.document.events.on("reset", render);
}

export { PALETTES };
