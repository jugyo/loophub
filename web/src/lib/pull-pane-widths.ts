// The PR detail left column's dragged widths, stored per browser in localStorage so they survive
// reloading and opening another PR. The left column is what is stored because the right pane takes
// whatever the window has left. Storage is a convenience only: a missing, unrecognized, or
// unreadable value means the view's default width, and a failed write is ignored.

// The Files view is read at a different width from the others, so it remembers its own: one width
// for its file list and diffs, so opening a file does not move the boundary.
export type PullPaneWidthGroup = "files" | "other";

const WIDTH_KEYS: Record<PullPaneWidthGroup, string> = {
  // Named for when only the diff used it; kept so widths already stored survive.
  files: "lh_pull_left_column_width_diff",
  other: "lh_pull_left_column_width",
};

const PANE_MIN_WIDTH = 320;
const LEFT_COLUMN_MIN_WIDTH = 320;
const RAIL_WIDTH = 48;
const RESERVED_WIDTH = PANE_MIN_WIDTH + RAIL_WIDTH;

export function clampPullLeftColumnWidth(
  width: number,
  containerWidth: number,
): number {
  return Math.max(
    LEFT_COLUMN_MIN_WIDTH,
    Math.min(width, containerWidth - RESERVED_WIDTH),
  );
}

export function getPullLeftColumnWidth(
  group: PullPaneWidthGroup,
): number | null {
  try {
    const stored = Number(globalThis.localStorage.getItem(WIDTH_KEYS[group]));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function setPullLeftColumnWidth(
  group: PullPaneWidthGroup,
  width: number,
): void {
  try {
    globalThis.localStorage.setItem(WIDTH_KEYS[group], String(width));
  } catch {
    // The dragged width still applies until the page is left.
  }
}
