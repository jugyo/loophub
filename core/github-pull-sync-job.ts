import { db } from "./db.ts";
import { type GithubSyncDeps, syncGithubPull } from "./github-sync.ts";
import * as J from "./store/jobs.ts";
import * as S from "./store.ts";

// An on-demand sync of one linked PR with GitHub, run by lh-job-queue so the request that asks for
// it never waits on `gh`.
export const SYNC_GITHUB_PULL_JOB = "github_pull.sync";

const keyPrefix = (issueId: number) => `${SYNC_GITHUB_PULL_JOB}:${issueId}:`;

/** The PR's newest sync job, which is what its screen shows. */
export function latestGithubPullSyncJob(issueId: number): J.JobRow | null {
  return J.latestByKeyPrefix(keyPrefix(issueId));
}

/** Queue a sync of the PR, or return the one still waiting or running. */
export function enqueueGithubPullSync(link: S.GithubSyncRow): J.JobRow {
  return db.transaction(() => {
    const latest = latestGithubPullSyncJob(link.issue_id);
    if (latest && (latest.status === "queued" || latest.status === "running"))
      return latest;
    const id = J.enqueue({
      type: SYNC_GITHUB_PULL_JOB,
      repoId: link.repo_id,
      dedupeKey: `${keyPrefix(link.issue_id)}${(latest?.id ?? 0) + 1}`,
      params: { issue_id: link.issue_id },
    });
    return J.get(id)!;
  });
}

// Run a claimed sync job. The job's outcome commits with an event, so an open PR screen learns that
// the sync it asked for has finished even when nothing on GitHub changed.
export async function runGithubPullSyncJob(
  job: { id: number; params: string },
  deps: Partial<GithubSyncDeps> = {},
): Promise<void> {
  let link: S.GithubSyncRow | null = null;
  let error: string | null = null;
  try {
    const { issue_id } = JSON.parse(job.params) as { issue_id?: number };
    link = Number.isInteger(issue_id) ? S.githubSyncRow(issue_id!) : null;
    if (!link) throw new Error("PR has no linked GitHub PR");
    const result = await syncGithubPull(link, undefined, deps);
    if (result.failures.length > 0)
      error = result.failures.map((f) => `${f.part}: ${f.error}`).join("\n");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  db.transaction(() => {
    J.finish(
      job.id,
      error === null ? { status: "done" } : { status: "failed", error },
    );
    if (link)
      S.emitEvent(
        link.repo_id,
        "pull_request.github_sync_finished",
        "lh-job-queue",
        {
          number: link.number,
        },
      );
  });
}
