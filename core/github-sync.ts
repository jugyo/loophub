import { fetchRemote } from "./git.ts";
import {
  type GithubFeedbackDeps,
  type GithubMergeStatusDeps,
  realGithubFeedbackDeps,
  realGithubMergeStatusDeps,
  realGithubPrStatusDeps,
} from "./github.ts";
import { syncGithubPullFeedback } from "./github-feedback-sync.ts";
import { syncGithubPullMerge } from "./github-merge-sync.ts";
import {
  type GithubPrStatusSyncDeps,
  syncGithubPullStatus,
} from "./github-status-sync.ts";
import * as S from "./store.ts";

// The GitHub reads one PR's sync is made of: merge detection, the PR status cache, and comments and
// reviews.
export type GithubSyncPart = "merge" | "status" | "feedback";

export const GITHUB_SYNC_PARTS: readonly GithubSyncPart[] = [
  "merge",
  "status",
  "feedback",
];

export type GithubSyncDeps = GithubMergeStatusDeps &
  GithubPrStatusSyncDeps &
  GithubFeedbackDeps;

const realGithubSyncDeps: GithubSyncDeps = {
  ...realGithubMergeStatusDeps,
  ...realGithubPrStatusDeps,
  ...realGithubFeedbackDeps,
  fetchOrigin: fetchRemote,
};

export interface GithubSyncFailure {
  part: GithubSyncPart;
  error: string;
}

export interface GithubPullSyncResult {
  emitted: S.EventRow[];
  statusRefreshed: boolean;
  failures: GithubSyncFailure[];
}

export interface GithubSyncResult {
  checked: number;
  emitted: S.EventRow[];
  statusRefreshed: number;
  failures: Array<
    GithubSyncFailure & { number: number; github_number: number }
  >;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Sync one linked PR with GitHub. Each part is its own failure boundary: a failed read is returned
// in `failures` while what the other parts fetched is still saved, and the next tick retries.
export async function syncGithubPull(
  link: S.GithubSyncRow,
  parts: readonly GithubSyncPart[] = GITHUB_SYNC_PARTS,
  deps: Partial<GithubSyncDeps> = {},
): Promise<GithubPullSyncResult> {
  const d = { ...realGithubSyncDeps, ...deps };
  const result: GithubPullSyncResult = {
    emitted: [],
    statusRefreshed: false,
    failures: [],
  };
  const run = async (part: GithubSyncPart, fn: () => Promise<void>) => {
    if (!parts.includes(part)) return;
    try {
      await fn();
    } catch (error) {
      result.failures.push({ part, error: errorMessage(error) });
    }
  };
  // A link already known merged on GitHub has nothing left to detect.
  await run("merge", async () => {
    if (link.github_merged) return;
    const event = await syncGithubPullMerge(link, d);
    if (event) result.emitted.push(event);
  });
  await run("status", async () => {
    const originError = await syncGithubPullStatus(link, d);
    result.statusRefreshed = true;
    if (originError)
      result.failures.push({ part: "status", error: originError });
  });
  await run("feedback", async () => {
    result.emitted.push(...(await syncGithubPullFeedback(link, d)));
  });
  return result;
}

// The periodic sync: every target from S.githubSyncRows(), one PR at a time.
export async function syncGithubPulls(
  parts: readonly GithubSyncPart[] = GITHUB_SYNC_PARTS,
  deps: Partial<GithubSyncDeps> = {},
): Promise<GithubSyncResult> {
  const result: GithubSyncResult = {
    checked: 0,
    emitted: [],
    statusRefreshed: 0,
    failures: [],
  };
  for (const link of S.githubSyncRows()) {
    result.checked++;
    const pull = await syncGithubPull(link, parts, deps);
    result.emitted.push(...pull.emitted);
    if (pull.statusRefreshed) result.statusRefreshed++;
    for (const failure of pull.failures)
      result.failures.push({
        number: link.number,
        github_number: link.github_number,
        ...failure,
      });
  }
  return result;
}
