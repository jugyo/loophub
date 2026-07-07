import { type RefObject, useEffect } from "react";
import {
  hasPlainShortcutModifiers,
  isEditableShortcutTarget,
  isShortcutOverlayActive,
} from "@/lib/keyboard-shortcuts";

const ISSUE_ROW_SELECTOR = "[data-issue-row]";
const ISSUE_LINK_SELECTOR = "[data-issue-row-link]";

function issueRows(container: HTMLElement | null): HTMLElement[] {
  return Array.from(
    (container ?? document).querySelectorAll<HTMLElement>(ISSUE_ROW_SELECTOR),
  );
}

function closestIssueRow(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(ISSUE_ROW_SELECTOR)
    : null;
}

function focusRow(row: HTMLElement) {
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

function openRow(row: HTMLElement) {
  row.querySelector<HTMLAnchorElement>(ISSUE_LINK_SELECTOR)?.click();
}

export function useIssueKeyboardNavigation(
  containerRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        hasPlainShortcutModifiers(event) ||
        isEditableShortcutTarget(event.target) ||
        isShortcutOverlayActive(event.target)
      ) {
        return;
      }

      const rows = issueRows(containerRef.current);
      if (rows.length === 0) return;

      const key = event.key;
      if (
        key !== "j" &&
        key !== "k" &&
        key !== "ArrowDown" &&
        key !== "ArrowUp" &&
        key !== "Enter"
      ) {
        return;
      }

      const currentRow = closestIssueRow(event.target);
      const currentIndex = currentRow ? rows.indexOf(currentRow) : -1;

      if (key === "Enter") {
        if (!currentRow) return;
        if (
          event.target instanceof Element &&
          event.target.closest("a, button, [role='button'], [role='menuitem']")
        ) {
          return;
        }
        event.preventDefault();
        openRow(currentRow);
        return;
      }

      event.preventDefault();
      const direction = key === "j" || key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        currentIndex === -1
          ? 0
          : Math.min(rows.length - 1, Math.max(0, currentIndex + direction));
      focusRow(rows[nextIndex]);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [containerRef]);
}
