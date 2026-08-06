// Tab-key focus trap for modal dialogs. Keeps keyboard navigation inside a dialog's focusable
// descendants so Tab does not escape into the page behind the overlay.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export const dialogFocusableSelector =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

export function trapDialogFocus(
  event: ReactKeyboardEvent<HTMLElement>,
  dialog: HTMLElement,
) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector),
  ).filter((element) => !element.closest("[hidden]"));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
