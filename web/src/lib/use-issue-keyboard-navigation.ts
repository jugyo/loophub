import { type RefObject, useEffect } from "react";
import {
  hasPlainShortcutModifiers,
  isEditableShortcutTarget,
  isShortcutOverlayActive,
} from "@/lib/keyboard-shortcuts";

const ISSUE_ROW_SELECTOR = "[data-issue-row]";
const ISSUE_LINK_SELECTOR = "[data-issue-row-link]";
const ISSUE_KEY_ATTR = "data-issue-key";

// Remembers the row the user last selected via keyboard so that returning to a
// list (client-side navigation — e.g. opening an issue with Enter and coming
// back) restores that selection instead of clearing it (#869). Module-level on
// purpose: it survives the row unmount/mount that in-app navigation causes, and
// resets on a full page reload (persistence across reload is out of scope).
let selectedIssueKey: string | null = null;

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

function rowByKey(rows: HTMLElement[], key: string): HTMLElement | null {
  return rows.find((row) => row.getAttribute(ISSUE_KEY_ATTR) === key) ?? null;
}

function focusRow(row: HTMLElement) {
  selectedIssueKey = row.getAttribute(ISSUE_KEY_ATTR);
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

  // Restore the remembered selection when an issue list re-appears (the user
  // navigated back to it). We latch on the restored *element*, not a boolean, so
  // we restore focus once per row node yet still re-restore when a re-render
  // swaps the remembered row for a fresh node carrying the same key (a whole-list
  // remount / filter change that keeps the selected issue) — which drops focus in
  // a single mutation batch. Ambient in-place updates (SSE badge refreshes,
  // relative-time ticks) don't replace the node, so focus is never stolen while
  // the user is on the list. #869
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let restoredNode: HTMLElement | null = null;

    function sync() {
      const target = selectedIssueKey
        ? rowByKey(issueRows(container), selectedIssueKey)
        : null;
      if (!target) {
        // Remembered row is absent — arm to restore when it next appears.
        restoredNode = null;
        return;
      }
      // Already restored to this exact node — nothing to do.
      if (target === restoredNode) return;
      restoredNode = target;
      // Don't hijack focus from a field the user is typing in or a row they
      // already have selected.
      if (isEditableShortcutTarget(document.activeElement)) return;
      if (closestIssueRow(document.activeElement)) return;
      focusRow(target);
    }

    const observer = new MutationObserver(sync);
    observer.observe(container, { childList: true, subtree: true });
    sync();
    return () => observer.disconnect();
  }, [containerRef]);
}
