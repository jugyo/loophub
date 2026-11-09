// The PR detail right pane's dragged widths, stored per browser in localStorage so they survive
// reloading and opening another PR. Storage is a convenience only: a missing, unrecognized, or
// unreadable value means the view's default width, and a failed write is ignored.

// The Diff view is read at a different width from the others, so it remembers its own.
export type PullPaneWidthGroup = "diff" | "other";

const WIDTH_KEYS: Record<PullPaneWidthGroup, string> = {
  diff: "lh_pull_pane_width_diff",
  other: "lh_pull_pane_width",
};

const PANE_MIN_WIDTH = 320;
const LEFT_COLUMN_MIN_WIDTH = 320;
const RAIL_WIDTH = 48;
const RESERVED_WIDTH = LEFT_COLUMN_MIN_WIDTH + RAIL_WIDTH;

// Also applied as CSS, so a window narrowed after the drag cannot squeeze the left column away.
export const PULL_PANE_MAX_WIDTH = `calc(100% - ${RESERVED_WIDTH}px)`;

export function clampPullPaneWidth(
  width: number,
  containerWidth: number,
): number {
  return Math.max(
    PANE_MIN_WIDTH,
    Math.min(width, containerWidth - RESERVED_WIDTH),
  );
}

export function getPullPaneWidth(group: PullPaneWidthGroup): number | null {
  try {
    const stored = Number(globalThis.localStorage.getItem(WIDTH_KEYS[group]));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function setPullPaneWidth(
  group: PullPaneWidthGroup,
  width: number,
): void {
  try {
    globalThis.localStorage.setItem(WIDTH_KEYS[group], String(width));
  } catch {
    // The dragged width still applies until the page is left.
  }
}
