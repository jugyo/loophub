// How the viewed record (#2502) reads against the PR's current diff. Files changed and the diff
// dialog's file tree both hide viewed files by default, so the rule lives here rather than in
// either screen.
import type { PullFile, PullFileView } from "@/api/types";

/**
 * - `unviewed`: never marked, or unmarked since.
 * - `viewed`: marked at the commit that is still the file's newest — nothing new to read.
 * - `changed`: marked, but the file has moved on to a later commit since.
 */
export type PullFileViewState = "unviewed" | "viewed" | "changed";

/** The newest record per path, keyed the way the screens key a file: by `filename`. */
export function pullFileViewsByPath(
  views: readonly PullFileView[] | undefined,
): ReadonlyMap<string, PullFileView> {
  return new Map((views ?? []).map((view) => [view.path, view]));
}

export function pullFileViewState(
  file: PullFile,
  viewsByPath: ReadonlyMap<string, PullFileView>,
): PullFileViewState {
  const view = viewsByPath.get(file.filename);
  if (!view) return "unviewed";
  return view.sha === (file.last_changed_sha ?? null) ? "viewed" : "changed";
}

/**
 * What a file list shows. `changed` files stay in the default list — the point of pinning the
 * commit is that a mark stops hiding a file once new commits touch it.
 */
export function visiblePullFiles(
  files: readonly PullFile[],
  viewsByPath: ReadonlyMap<string, PullFileView>,
  showViewed: boolean,
): PullFile[] {
  if (showViewed) return [...files];
  return files.filter(
    (file) => pullFileViewState(file, viewsByPath) !== "viewed",
  );
}

/** How many files carry a mark that still stands — the count the "Show viewed" hint reports. */
export function viewedPullFileCount(
  files: readonly PullFile[],
  viewsByPath: ReadonlyMap<string, PullFileView>,
): number {
  return files.filter(
    (file) => pullFileViewState(file, viewsByPath) === "viewed",
  ).length;
}
