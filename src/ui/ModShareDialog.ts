import type { EditorContext } from "@plugins/api";
import { isDownloadUrl } from "@core/atmosphere";
import { el } from "./dom";
import { openDialog } from "./dialog";

/** The sun/sky mod a save just wrote (tools/gameBridge.ts). */
export interface SavedSunMod {
  name: string;
  bytes: number;
  /** Set when the save already carried a confirmed upload of this exact zip. */
  url: string | null;
}

const size = (bytes: number): string => (bytes > 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

/**
 * After a save wrote a custom sun/sky: the look lives in a mod zip on this
 * machine, so other players only see it once the zip is online and the map
 * carries its link. Three steps — get the file (browser download, or shown
 * in the file manager), upload it anywhere that serves it directly, paste
 * the link. The dev server downloads the link and compares it with the zip
 * before the map is rewritten, so a share page or a stale upload is caught
 * here and not by players.
 */
export function openModShareDialog(ctx: EditorContext, mod: SavedSunMod, mapPath: string): void {
  const post = async (route: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/game/mod/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as { error?: string; verified?: boolean; reason?: string; written?: boolean; folder?: string };
    if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };

  const result = el("p", { class: "share-result" });
  const say = (text: string, kind: "" | "ok" | "bad" = "") => {
    result.textContent = text;
    result.className = `share-result ${kind}`;
  };

  const download = el("button", {
    class: "btn",
    onclick: () => el("a", { href: `/api/game/mod/${encodeURIComponent(mod.name)}`, download: mod.name }).click(),
  }, "Download the zip");
  const reveal = el("button", {
    class: "btn",
    onclick: () => void post("reveal", { name: mod.name })
      .then((r) => say(`Shown in your file manager: ${r.folder}`))
      .catch((err) => say(`Could not open the folder: ${err instanceof Error ? err.message : err}`, "bad")),
  }, "Show it in its folder");

  const input = el("input", { class: "input", type: "url", placeholder: "https://…/" + mod.name, spellcheck: false });
  const use = el("button", { class: "btn primary" }, "Check and use");
  const anyway = el("button", { class: "btn danger" }, "Use it anyway");
  anyway.hidden = true;

  let dialog: { close: () => void } | null = null;
  const submit = async (force: boolean) => {
    const url = input.value.trim();
    anyway.hidden = true;
    if (!isDownloadUrl(url)) return say("Paste the full link, starting with https://", "bad");
    use.disabled = anyway.disabled = true;
    say("Downloading the link to compare it with the zip…");
    try {
      const r = await post("url", { name: mod.name, url, mapPath, force });
      if (r.written) {
        ctx.document.setAtmosphere({ hosted: { name: mod.name, url } });
        ctx.ui.setStatus(r.verified
          ? "The map now carries the mod's link: other players download the look with it."
          : "The map now carries the link, unchecked — test it from another machine.");
        dialog?.close();
        return;
      }
      say(r.reason ?? "The link does not serve this file.", "bad");
      anyway.hidden = false;
    } catch (err) {
      say(`${err instanceof Error ? err.message : err}`, "bad");
    } finally {
      use.disabled = anyway.disabled = false;
    }
  };
  use.addEventListener("click", () => void submit(false));
  anyway.addEventListener("click", () => void submit(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit(false);
  });

  const content = el("div", { class: "mod-share" },
    el("p", { class: "dialog-message" },
      "The custom sun and sky are in a mod file on this machine. The map is saved and looks right here. For anyone else to see it, the file has to be online and the map has to know where."),
    el("div", { class: "share-step" }, el("b", {}, "1"), el("div", {},
      el("div", { class: "share-title" }, "Get the file"),
      el("div", { class: "share-file" }, `${mod.name} · ${size(mod.bytes)}`),
      el("div", { class: "share-buttons" }, download, reveal))),
    el("div", { class: "share-step" }, el("b", {}, "2"), el("div", {},
      el("div", { class: "share-title" }, "Upload it"),
      el("p", { class: "hint" },
        "Anywhere that serves the file itself: your own site, a bucket, a GitHub release asset. Keep the file name. " +
        "Links that open a page with a download button do not work — the game fetches the link as is."))),
    el("div", { class: "share-step" }, el("b", {}, "3"), el("div", {},
      el("div", { class: "share-title" }, "Paste its link"),
      el("div", { class: "share-buttons" }, input, use, anyway),
      result)),
    el("p", { class: "hint" }, "Change the sun or the sky image later and the zip changes with it: the next save asks again."),
  );

  dialog = openDialog({
    title: "Share this map's sky",
    content,
    width: 460,
    actions: [{ label: "Only on this machine", onClick: () => {} }],
  });
}
