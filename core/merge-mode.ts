// Pure, side-effect-free decisioning for the PR-detail write action (#406): does a PR offer the
// internal "Merge" button or "Create PR on GitHub"? The two are mutually exclusive per repo. The
// stored per-repo setting (repos.merge_mode) wins when set; otherwise the default follows whether
// the repo has a GitHub remote. Kept out of service.ts so it can be unit-tested without a DB/git.

export type MergeMode = "merge" | "github_pr";

export const MERGE_MODES: readonly MergeMode[] = [
  "merge",
  "github_pr",
] as const;

// Validate a raw stored/incoming value into a MergeMode, or null for "unset / default-by-remote".
// Any other value (legacy, typo) collapses to null so the default path takes over rather than
// throwing on read.
export function normalizeMergeMode(
  raw: string | null | undefined,
): MergeMode | null {
  return raw === "merge" || raw === "github_pr" ? raw : null;
}

// Whether a git remote URL points at GitHub. Accepts the common forms `git remote get-url` emits:
//   https://github.com/owner/repo(.git)
//   git@github.com:owner/repo(.git)
//   ssh://git@github.com/owner/repo(.git)
// Matches github.com and any subdomain (e.g. GitHub Enterprise `github.example.com` is NOT matched —
// only the public host and its subdomains like `www.github.com`). Case-insensitive; null/empty → false.
export function isGithubRemoteUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const u = url.trim().toLowerCase();
  // scp-like syntax: git@github.com:owner/repo
  const scp = /^[^/@]+@([^:]+):/.exec(u);
  const host = scp
    ? scp[1]
    : (() => {
        try {
          return new URL(u).hostname;
        } catch {
          return "";
        }
      })();
  return host === "github.com" || host.endsWith(".github.com");
}

// Extract the PR number from a GitHub PR URL (e.g. `https://github.com/o/r/pull/42`), for callers
// that only have the URL and want to avoid also requiring the number as a separate input (#487).
// Returns null if the URL has no `/pull/<digits>` segment.
export function parseGithubPullNumber(
  url: string | null | undefined,
): number | null {
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Resolve the effective mode for a repo: the pinned setting if any, else the remote-based default
// (github_pr when a GitHub remote exists, merge otherwise).
export function effectiveMergeMode(
  setting: string | null | undefined,
  hasGithubRemote: boolean,
): MergeMode {
  const pinned = normalizeMergeMode(setting);
  if (pinned) return pinned;
  return hasGithubRemote ? "github_pr" : "merge";
}
