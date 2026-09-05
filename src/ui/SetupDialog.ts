import { el } from "./dom";
import { confirmDialog, openDialog } from "./dialog";

/**
 * First-run setup dialog. Game meshes/textures are Nadeo's content and never
 * ship with the repo, so each user extracts them from their own TM2020
 * install (via the bundled Openplanet plugin) and imports them locally. The
 * dialog walks the three steps and stays around until they're all done —
 * everything server-side happens in the setup bridge (vite.config.ts):
 *
 *   1. point at the OpenplanetNext folder (plugin auto-installs into it)
 *   2. run "Trackedit Extract" in-game (we watch the extract folder fill up)
 *   3. import: meshdump converts the extraction into public/meshes/
 */

interface SetupStatus {
  openplanetDir: string | null;
  dirSource: "config" | "detected" | null;
  configured: boolean;
  dirValid: boolean;
  pluginInstalled: boolean;
  extractedFiles: number;
  extractReady: boolean;
  meshCount: number;
  meshesReady: boolean;
  importing: {
    running: boolean;
    phase: string;
    progress: number | null;
    log: string[];
    error: string | null;
    done: boolean;
  } | null;
}

export async function fetchSetupStatus(): Promise<SetupStatus | null> {
  try {
    const res = await fetch("/api/setup/status");
    if (!res.ok) return null;
    return (await res.json()) as SetupStatus;
  } catch {
    return null;
  }
}

/** True when the first-run walkthrough still has work to do. */
export function setupIncomplete(s: SetupStatus | null): boolean {
  return !!s && (!s.configured || !s.meshesReady);
}

/**
 * `locked` (the boot default) = mandatory first-run mode: no close until the
 * import is done. Unlocked (opened from the rail's asset button) = manage
 * mode: change the folder, re-import, or wipe the imported assets — closable
 * anytime (closing reloads if the assets on disk changed).
 */
export function openSetupDialog(initial: SetupStatus, opts?: { locked?: boolean }): void {
  const locked = opts?.locked ?? true;
  let status = initial;
  let assetsChanged = false;

  const refresh = async () => {
    const s = await fetchSetupStatus();
    if (s) {
      status = s;
      render();
    }
  };

  const glyph = (done: boolean, active = false) =>
    el("span", { class: `setup-glyph${done ? " done" : active ? " active" : ""}` }, done ? "✓" : "○");

  // Step 1 — Openplanet folder
  const dirInput = el("input", {
    type: "text",
    placeholder: "C:\\Users\\you\\OpenplanetNext",
    spellcheck: "false",
  }) as HTMLInputElement;
  dirInput.value = status.openplanetDir ?? "";
  const dirNote = el("div", { class: "hint" });
  const dirBtn = el("button", { class: "btn" }, "Use this folder") as HTMLButtonElement;
  dirBtn.addEventListener("click", () => {
    dirBtn.disabled = true;
    void fetch("/api/setup/dir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: dirInput.value.trim() }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
        await refresh();
      })
      .catch((err) => (dirNote.textContent = `✗ ${err instanceof Error ? err.message : err}`))
      .finally(() => (dirBtn.disabled = false));
  });

  // Step 2 — extract in-game
  const extractNote = el("div", { class: "hint" });

  // Step 3 — import
  const importBtn = el("button", { class: "btn primary" }, "Import models & textures") as HTMLButtonElement;
  const importNote = el("div", { class: "hint" });
  const barFill = el("div", { class: "setup-bar-fill" });
  const barText = el("span", { class: "setup-bar-text" });
  const importBar = el("div", { class: "setup-bar" }, barFill, barText);
  importBar.hidden = true;
  const importLog = el("pre", { class: "setup-log" });
  importLog.hidden = true;
  importBtn.addEventListener("click", () => {
    importBtn.disabled = true;
    assetsChanged = true;
    void fetch("/api/setup/import", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
        await refresh();
      })
      .catch((err) => {
        importNote.textContent = `✗ ${err instanceof Error ? err.message : err}`;
        importBtn.disabled = false;
      });
  });

  // Manage mode extra: wipe everything imported (meshes, textures, mods)
  // for a clean redo — e.g. after a game update or a broken import.
  const removeBtn = el("button", { class: "btn danger" }, "Remove imported assets") as HTMLButtonElement;
  removeBtn.hidden = true;
  removeBtn.addEventListener("click", () => {
    void confirmDialog({
      title: "Remove imported assets",
      message:
        "Deletes everything under public/meshes — all imported models, textures " +
        "and downloaded texture packs. Your maps are untouched. Re-importing " +
        "rebuilds it from the extraction.",
      confirmLabel: "Delete",
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      assetsChanged = true;
      void fetch("/api/setup/reset", { method: "POST" })
        .then(async (res) => {
          if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
          await refresh();
        })
        .catch((err) => (importNote.textContent = `✗ ${err instanceof Error ? err.message : err}`));
    });
  });

  const stepGlyphs = [el("span"), el("span"), el("span")];
  const content = el("div", { class: "setup" },
    el("p", { class: "dialog-message" },
      "Track geometry and textures come from your own Trackmania 2020 install — " +
      "they're Nadeo's content, so the editor imports them locally instead of shipping them."),
    el("div", { class: "setup-step" },
      stepGlyphs[0],
      el("div", { class: "setup-step-body" },
        el("div", { class: "setup-step-title" }, "Openplanet folder"),
        el("div", { class: "setup-dir-row" }, dirInput, dirBtn),
        dirNote,
      ),
    ),
    el("div", { class: "setup-step" },
      stepGlyphs[1],
      el("div", { class: "setup-step-body" },
        el("div", { class: "setup-step-title" }, "Extract the game files"),
        el("div", { class: "hint" },
          "Launch TM2020 with Openplanet and set plugin signature mode to Developer " +
          "(F3 \u2192 Openplanet menu \u2192 Developer \u2192 Signature mode) so the local " +
          "Trackedit Extract plugin loads. Then click \u201CTrackedit Extract\u201D in the " +
          "Openplanet menu. It takes a few minutes; this dialog updates by itself once " +
          "files start appearing."),
        extractNote,
      ),
    ),
    el("div", { class: "setup-step" },
      stepGlyphs[2],
      el("div", { class: "setup-step-body" },
        el("div", { class: "setup-step-title" }, "Import into the editor"),
        el("div", { class: "setup-dir-row" }, importBtn, removeBtn),
        importBar,
        importNote,
        importLog,
      ),
    ),
  );

  // First run is locked: real geometry is a prerequisite for editing, so
  // the dialog can't be dismissed until the import has actually happened.
  openDialog({
    title: locked ? "Get started" : "Game assets",
    content,
    width: 520,
    locked,
    actions: [
      locked
        ? {
            label: "Start editing",
            primary: true,
            onClick: () => {
              if (!(status.configured && status.meshesReady)) return false;
              location.reload();
              return true;
            },
          }
        : {
            label: "Close",
            primary: true,
            onClick: () => {
              if (status.importing?.running) return false;
              if (assetsChanged) location.reload();
            },
          },
    ],
  });

  const render = () => {
    const s = status;
    const step1 = s.configured && s.dirValid;
    const step2 = s.extractReady;
    const step3 = s.meshesReady;

    stepGlyphs[0].replaceWith(stepGlyphs[0] = glyph(step1, true));
    stepGlyphs[1].replaceWith(stepGlyphs[1] = glyph(step2, step1));
    stepGlyphs[2].replaceWith(stepGlyphs[2] = glyph(step3, step2));

    if (!dirInput.value && s.openplanetDir) dirInput.value = s.openplanetDir;
    dirNote.textContent = step1
      ? `✓ Plugin ${s.pluginInstalled ? "installed" : "NOT installed — is this the OpenplanetNext folder?"}`
      : s.dirSource === "detected"
        ? "Auto-detected — confirm to continue."
        : "Install Openplanet from openplanet.dev, then point here at its OpenplanetNext folder.";

    extractNote.textContent = s.extractedFiles > 0
      ? `${s.extractedFiles.toLocaleString()} files extracted${step2 ? "" : " so far…"}`
      : step1 ? "Waiting for extraction…" : "";

    const imp = s.importing;
    if (imp?.done) assetsChanged = true;
    importBtn.disabled = !step2 || !!imp?.running || (locked && step3);
    importBtn.textContent = imp?.running
      ? `Importing ${imp.phase}…`
      : step3 ? (locked ? "Imported" : "Re-import models & textures") : "Import models & textures";
    removeBtn.hidden = locked || !step3;

    // Progress bar: blocks are ~85% of the work, items the rest. Until the
    // first "progress a/b" line lands (dotnet build, file scan) it pulses.
    importBar.hidden = !imp?.running;
    if (imp?.running) {
      const local = imp.progress;
      const overall =
        imp.phase === "items" ? 0.85 + 0.15 * (local ?? 0) : 0.85 * (local ?? 0);
      importBar.classList.toggle("indeterminate", local === null && imp.phase === "blocks");
      barFill.style.width = `${Math.round(overall * 100)}%`;
      barText.textContent = local === null && imp.phase === "blocks"
        ? "preparing…"
        : `${imp.phase} ${Math.round(overall * 100)}%`;
    }
    importLog.hidden = !imp || (!imp.running && !imp.error);
    if (imp) importLog.textContent = imp.log.slice(-8).join("\n");
    if (imp?.error) importNote.textContent = `✗ ${imp.error}`;
    else if (step3)
      importNote.textContent = `✓ ${s.meshCount.toLocaleString()} meshes ready${locked ? " — hit Start editing." : "."}`;
    else if (imp?.running) importNote.textContent = "Converting meshes and textures — takes a few minutes.";
    else importNote.textContent = "";
  };
  render();

  // Poll while open (faster during an import); stop when the dialog is gone.
  const tick = async () => {
    if (!content.isConnected) return;
    const s = await fetchSetupStatus();
    if (s) {
      status = s;
      render();
    }
    window.setTimeout(() => void tick(), status.importing?.running ? 1200 : 2500);
  };
  window.setTimeout(() => void tick(), 2500);
}
