// The PR detail left column's dragged width, stored per browser in localStorage so it survives
// reloading and opening another PR. The left column is what is stored because the right pane takes
// whatever the window has left. Every pane view shares the one width, so switching views does not
// move the boundary. Storage is a convenience only: a missing, unrecognized, or unreadable value
// means the default width, and a failed write is ignored.

const WIDTH_KEY = "lh_pull_left_column_width";

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

export function getPullLeftColumnWidth(): number | null {
  try {
    const stored = Number(globalThis.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function setPullLeftColumnWidth(width: number): void {
  try {
    globalThis.localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // The dragged width still applies until the page is left.
  }
}
