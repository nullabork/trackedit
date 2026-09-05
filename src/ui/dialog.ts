import { el } from "./dom";
import { icon } from "./icons";

/**
 * Dialogs (style guide §5.5): chamfered panel over a dimmed backdrop.
 * Dialogs stack — each opens above the last and Esc/✕ closes only the top
 * one. The backdrop click also closes (top only).
 */

export interface DialogAction {
  label: string;
  primary?: boolean;
  danger?: boolean;
  /** Return false to keep the dialog open. */
  onClick: () => boolean | void;
}

let stackDepth = 0;

export function openDialog(opts: {
  title: string;
  content: HTMLElement;
  actions?: DialogAction[];
  width?: number;
  /** Locked dialogs have no ✕ and ignore Esc/backdrop — only an action's
   *  onClick (returning non-false) closes them. For must-complete flows. */
  locked?: boolean;
}): { close: () => void } {
  stackDepth += 1;
  const overlay = el("div", { class: "dialog-overlay" });
  overlay.style.zIndex = String(100 + stackDepth);

  const close = () => {
    stackDepth -= 1;
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };

  const onKey = (e: KeyboardEvent) => {
    // Only the top dialog reacts.
    if (overlay.nextElementSibling?.classList.contains("dialog-overlay")) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!opts.locked) close();
    }
  };
  window.addEventListener("keydown", onKey, true);

  const actionButtons = (opts.actions ?? []).map((a) =>
    el("button", {
      class: `btn${a.primary ? " primary" : ""}${a.danger ? " danger" : ""}`,
      onclick: () => {
        if (a.onClick() !== false) close();
      },
    }, a.label),
  );

  const panel = el("div", { class: "dialog" },
    el("div", { class: "dialog-head" },
      el("span", { class: "dialog-title" }, el("span", {}, opts.title)),
      opts.locked ? null : el("button", { class: "dialog-close", onclick: close }, icon("x")),
    ),
    el("div", { class: "dialog-body" }, opts.content),
    actionButtons.length ? el("div", { class: "dialog-foot" }, ...actionButtons) : null,
  );
  if (opts.width) panel.style.width = `${opts.width}px`;

  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay && !opts.locked) close();
  });
  overlay.append(panel);
  document.body.append(overlay);
  return { close };
}

/** Confirm helper — resolves true when the user accepts. */
export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const body = el("p", { class: "dialog-message" }, opts.message);
    openDialog({
      title: opts.title,
      content: body,
      width: 340,
      actions: [
        { label: "Cancel", onClick: () => resolve(false) },
        {
          label: opts.confirmLabel ?? "Confirm",
          primary: !opts.danger,
          danger: opts.danger,
          onClick: () => resolve(true),
        },
      ],
    });
  });
}
