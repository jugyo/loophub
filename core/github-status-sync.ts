import { fetchRemote } from "./git.ts";
import type { GithubPrStatusDeps } from "./github.ts";
import { sweepPullConflicts } from "./pull-conflict-events.ts";
import type * as S from "./store.ts";

export interface GithubPrStatusSyncDeps extends GithubPrStatusDeps {
  fetchOrigin?: typeof fetchRemote;
}

// Refresh the cache pulls/githubStatus reads for one linked PR. A GitHub read failure throws to the
// caller and the old cache stays readable. Returns the error of a failed local origin refresh, which
// does not discard the fresh status.
export async function syncGithubPullStatus(
  link: S.GithubSyncRow,
  deps: GithubPrStatusSyncDeps,
): Promise<string | null> {
  const status = await deps.fetchStatus(link.local_path, link.url);
  let originError: string | null = null;
  // GitHub evaluates the remote PR refs, while the local conflict sweep compares the checkout's
  // refs. Refresh origin before projecting a GitHub conflict into the local resolution path so
  // the executor sees the base revision that produced the remote result.
  if (status.mergeable === "conflicting") {
    const fetched = await (deps.fetchOrigin ?? fetchRemote)(
      link.local_path,
      "origin",
    );
    // The GitHub observation is still authoritative when the local refresh fails. Keep the
    // failure visible in the result, but do not discard the status or its conflict edge.
    if (fetched.code !== 0)
      originError = `git fetch origin failed: ${fetched.stderr.trim()}`;
  }
  await sweepPullConflicts({ issueId: link.issue_id, githubStatus: status });
  return originError;
}
