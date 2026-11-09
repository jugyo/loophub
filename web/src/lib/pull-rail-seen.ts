// What the reader last saw in each view of the PR detail's right pane, stored per browser in
// localStorage so the icon rail can flag a view whose content has moved on. Storage is a
// convenience only: an unreadable value means no baseline, and a failed write is ignored.

import type { PullFile, PullRequest, PullReview } from "@/api/types";
import type { PullPaneView } from "@/components/pull-section-tabs";

const KEY_PREFIX = "lh_pull_rail_seen";

// Files and Evidence are hashed because the only question asked of them is "did it change", and a
// PR body kept verbatim per PR would eat into the localStorage quota.
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
  }
  return (value >>> 0).toString(36);
}

/** The current content of each tracked view; a view whose data has not loaded is left out. */
export function pullRailFingerprints(
  pull: PullRequest,
  files: PullFile[] | undefined,
  reviews: PullReview[] | undefined,
): Partial<Record<PullPaneView, string>> {
  return {
    files:
      files &&
      hash(
        files
          .map((file) =>
            [
              file.filename,
              file.previousFilename,
              file.status,
              file.additions,
              file.deletions,
              file.last_changed_sha,
            ].join("\0"),
          )
          .join("\n"),
      ),
    // A list of ids rather than a hash: Commits is flagged only when something was added.
    commits:
      pull.commits && reviews
        ? [
            ...pull.commits.map((commit) => commit.sha),
            ...reviews.map((review) => `review:${review.id}`),
          ].join("\n")
        : undefined,
    evidence: hash(pull.body ?? ""),
  };
}

export function pullRailViewChanged(
  view: PullPaneView,
  seen: string,
  current: string,
): boolean {
  if (view !== "commits") return seen !== current;
  const seenIds = new Set(seen.split("\n"));
  return current.split("\n").some((id) => id !== "" && !seenIds.has(id));
}

export function getPullRailSeen(
  pullKey: string,
  view: PullPaneView,
): string | null {
  try {
    return globalThis.localStorage.getItem(`${KEY_PREFIX}:${pullKey}:${view}`);
  } catch {
    return null;
  }
}

export function setPullRailSeen(
  pullKey: string,
  view: PullPaneView,
  fingerprint: string,
): void {
  try {
    globalThis.localStorage.setItem(
      `${KEY_PREFIX}:${pullKey}:${view}`,
      fingerprint,
    );
  } catch {
    // The view is still shown as read while it stays open.
  }
}
