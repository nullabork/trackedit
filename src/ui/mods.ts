import type { EditorContext } from "@plugins/api";
import { el } from "./dom";
import { openDialog } from "./dialog";

/**
 * Custom texture packs ("mods"). TM2020 maps can reference a mod zip the
 * game downloads and applies map-wide; we mirror that via the dev-server
 * mod library (/api/mods — downloaded once, usable by ANY map afterwards).
 */

export interface ModEntry {
  slug: string;
  name: string;
  url: string;
  materials: number;
}

interface ModProvider {
  applyMod?(materials: Record<string, string> | null, base?: string): void;
}

export async function listMods(): Promise<ModEntry[]> {
  const res = await fetch("/api/mods");
  if (!res.ok) return [];
  return (await res.json()) as ModEntry[];
}

/** Download + convert a mod (idempotent — returns immediately when cached). */
export async function ensureMod(url: string, name?: string): Promise<ModEntry> {
  const res = await fetch("/api/mods", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, name }),
  });
  const body = (await res.json()) as ModEntry & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** Apply a downloaded mod's textures to the live scene (null clears). */
export async function applyModBySlug(ctx: EditorContext, slug: string | null): Promise<void> {
  const geometry = ctx.geometry as ModProvider;
  if (!slug) {
    geometry.applyMod?.(null);
    return;
  }
  const res = await fetch(`/api/mods/${slug}`);
  if (!res.ok) throw new Error(`mod ${slug} not in the library`);
  const mod = (await res.json()) as { materials: Record<string, string> };
  geometry.applyMod?.(mod.materials, `meshes/mods/${slug}/`);
}

/**
 * Rail-toggle behaviour: off -> on prefers the map's own pack (downloading
 * it on first use); a map without one gets the library picker instead.
 * Returns while the spinner should stop.
 */
export async function toggleMod(ctx: EditorContext): Promise<void> {
  const doc = ctx.document;
  if (doc.activeMod) {
    doc.setActiveMod(null);
    await applyModBySlug(ctx, null);
    ctx.ui.setStatus("Texture pack off");
    return;
  }
  if (doc.modUrl) {
    const entry = await ensureMod(doc.modUrl, doc.name);
    doc.setActiveMod(entry.slug);
    await applyModBySlug(ctx, entry.slug);
    ctx.ui.setStatus(`Texture pack "${entry.name}" on (${entry.materials} textures)`);
    return;
  }
  await openModPicker(ctx);
}

/** Pick any previously downloaded mod to apply to the current map. */
export async function openModPicker(ctx: EditorContext): Promise<void> {
  const mods = await listMods();
  if (mods.length === 0) {
    ctx.ui.setStatus("This map has no texture pack and none are downloaded yet");
    return;
  }
  const list = el("div", { class: "mod-list" });
  const dialog = openDialog({
    title: "Texture packs",
    content: list,
  });
  const row = (label: string, sub: string, slug: string | null) => {
    const b = el("button", { class: "mod-row" }, el("b", {}, label), el("span", {}, sub));
    b.addEventListener("click", () => {
      void (async () => {
        ctx.document.setActiveMod(slug);
        await applyModBySlug(ctx, slug);
        ctx.ui.setStatus(slug ? `Texture pack "${label}" on` : "Texture pack off");
        dialog.close();
      })();
    });
    return b;
  };
  list.append(row("None", "vanilla textures", null));
  for (const m of mods) list.append(row(m.name, `${m.materials} textures`, m.slug));
}
