import type { EditorContext } from "@plugins/api";
import { CELL } from "@core/math";
import { solveSun } from "@core/sun";
import { clockOf, customSunFrom, directionFrom, headingAltitude, lightDirection, MIN_SUN_ALTITUDE, MOOD_SUNS } from "@core/atmosphere";
import { SunDome } from "@render/SunDome";
import type { Tool, ToolPointerEvent } from "./Tool";

const SUN_HANDLE = "#ffd76a";
const MOON_HANDLE = "#9fb8ff";

/**
 * Place the sun by dragging it over a dome around the map. The direction is
 * solved into the two numbers the game takes (DayTime01, Latitude — see
 * core/sun.ts) and stored on the document; the moon sits opposite. Colours,
 * fog and the sky image live in the "Sky & light" drawer page.
 */
export class SunTool implements Tool {
  readonly id = "sun";
  readonly label = "Place the sun";
  readonly hint = "Drag over the dome to place the sun — the moon sits opposite. Esc returns to select.";
  private readonly dome: SunDome;
  private dragging = false;

  constructor(private ctx: EditorContext) {
    this.dome = new SunDome(1200);
    ctx.view.scene.add(this.dome.group);
    const refresh = () => this.refresh();
    ctx.document.events.on("atmosphereChanged", refresh);
    ctx.document.events.on("mapChanged", refresh);
    ctx.document.events.on("reset", refresh);
  }

  activate(): void {
    this.dome.group.visible = true;
    this.ctx.view.setAtmospherePreview(true);
    this.refresh();
  }

  deactivate(): void {
    this.dragging = false;
    this.dome.group.visible = false;
    this.ctx.view.setAtmospherePreview(false);
    this.ctx.ui.setHud(null);
  }

  private refresh(): void {
    if (!this.dome.group.visible) return;
    const doc = this.ctx.document;
    const size = doc.size;
    const radius = Math.max(size[0] * CELL[0], size[2] * CELL[2]) * 0.8;
    this.dome.setFrame(this.ctx.view.mapCentre, radius);
    const sun = doc.atmosphere.sun;
    const latitude = sun?.latitude ?? (MOOD_SUNS[doc.mood] ?? MOOD_SUNS.Day).latitude;
    this.dome.setSun(lightDirection(doc.mood, sun), latitude, sun?.color ?? SUN_HANDLE, sun?.moonColor ?? MOON_HANDLE);
  }

  private place(ev: ToolPointerEvent): void {
    const doc = this.ctx.document;
    const hit = this.dome.pick(ev.ray.ray, lightDirection(doc.mood, doc.atmosphere.sun));
    if (!hit) return;
    const at = headingAltitude(hit);
    const settings = solveSun(directionFrom(at.heading, Math.max(MIN_SUN_ALTITUDE, at.altitude)));
    if (!settings) return;
    doc.setAtmosphere({ sun: customSunFrom(settings, doc.atmosphere.sun) });
    this.ctx.ui.setHud([
      [`${at.heading.toFixed(0)}°`, " heading"],
      [`${Math.max(MIN_SUN_ALTITUDE, at.altitude).toFixed(0)}°`, " up"],
      [clockOf(settings.dayTime01), ` map time · latitude ${settings.latitude.toFixed(1)}`],
    ]);
  }

  onPointerDown(ev: ToolPointerEvent): void {
    this.dragging = true;
    this.place(ev);
  }

  onPointerMove(ev: ToolPointerEvent): void {
    if (this.dragging && (ev.native.buttons & 1)) this.place(ev);
    else this.dragging = false;
  }

  onPointerUp(): void {
    this.dragging = false;
    this.ctx.ui.setHud(null);
  }

  onKeyDown(ev: KeyboardEvent): boolean | void {
    if (ev.key === "Escape") {
      this.ctx.tools.setActive("select");
      return true;
    }
  }
}
