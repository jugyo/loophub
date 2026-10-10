// The Diff View's display modes, stored per browser in localStorage so a chosen mode survives
// closing the dialog, opening another PR, and reloading the page. Storage is a convenience only:
// a missing, unrecognized, or unreadable value falls back to the defaults, and a failed write is
// ignored.

export type DiffDialogMode = "diff" | "raw" | "base" | "head" | "rendered";
export type StandardDiffDialogMode = "diff" | "raw";
export type DiffViewMode = "unified" | "split";

const MARKDOWN_MODE_KEY = "lh_diff_markdown_mode";
const STANDARD_MODE_KEY = "lh_diff_standard_mode";
const VIEW_MODE_KEY = "lh_diff_view_mode";

const MARKDOWN_MODES: readonly DiffDialogMode[] = [
  "diff",
  "raw",
  "base",
  "head",
  "rendered",
];
const STANDARD_MODES: readonly StandardDiffDialogMode[] = ["diff", "raw"];
const VIEW_MODES: readonly DiffViewMode[] = ["unified", "split"];

function read<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const stored = globalThis.localStorage.getItem(key);
    return allowed.find((value) => value === stored) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    // The selected mode still applies for this dialog when storage is unavailable.
  }
}

export function getMarkdownDiffMode(): DiffDialogMode {
  return read(MARKDOWN_MODE_KEY, MARKDOWN_MODES, "diff");
}

export function setMarkdownDiffMode(mode: DiffDialogMode): void {
  write(MARKDOWN_MODE_KEY, mode);
}

export function getStandardDiffMode(): StandardDiffDialogMode {
  return read(STANDARD_MODE_KEY, STANDARD_MODES, "diff");
}

export function setStandardDiffMode(mode: StandardDiffDialogMode): void {
  write(STANDARD_MODE_KEY, mode);
}

export function getDiffViewMode(): DiffViewMode {
  return read(VIEW_MODE_KEY, VIEW_MODES, "unified");
}

export function setDiffViewMode(mode: DiffViewMode): void {
  write(VIEW_MODE_KEY, mode);
}
