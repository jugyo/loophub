import { ServiceError } from "./errors.ts";
import { git } from "./git.ts";
import {
  evaluateWorkflowSteps,
  type WorkflowLatestReviewState,
  type WorkflowStepStatuses,
} from "./workflow/steps.ts";

// The git/subprocess-touching observations behind a Workflow run's progress. Everything here is a
// near-pure query over a worktree — no store or lifecycle state — so the git dependency stays
// isolated from `workflowRuns` (see core/service/workflow-runs.ts). The (run) -> (worktree, base
// ref, latest review) resolution stays with the service; this module only observes.

export type WorkflowRunProgress = {
  currentHead: string | null;
  headAheadOfBase: boolean;
  steps: WorkflowStepStatuses;
};

export async function worktreeHead(worktree: string): Promise<string> {
  const result = await git(worktree, ["rev-parse", "HEAD"]);
  const sha = result.stdout.trim();
  if (result.code !== 0 || !sha) {
    throw new ServiceError(422, "could not resolve Workflow worktree HEAD");
  }
  return sha;
}

async function worktreeHeadOptional(worktree: string): Promise<string | null> {
  try {
    const result = await git(worktree, ["rev-parse", "HEAD"]);
    const sha = result.stdout.trim();
    return result.code === 0 && sha ? sha : null;
  } catch {
    return null;
  }
}

async function isHeadAheadOfBase(
  worktree: string,
  baseBranch: string,
  head: string | null,
): Promise<boolean> {
  if (!head) return false;
  try {
    const result = await git(worktree, [
      "rev-list",
      "--count",
      `${baseBranch}..${head}`,
    ]);
    return result.code === 0 && Number(result.stdout.trim()) > 0;
  } catch {
    return false;
  }
}

export async function workflowRunProgress(input: {
  worktree: string;
  baseBranch: string;
  latestReview: WorkflowLatestReviewState | null;
}): Promise<WorkflowRunProgress> {
  const currentHead = await worktreeHeadOptional(input.worktree);
  const headAheadOfBase = await isHeadAheadOfBase(
    input.worktree,
    input.baseBranch,
    currentHead,
  );
  return {
    currentHead,
    headAheadOfBase,
    steps: evaluateWorkflowSteps({
      currentHead,
      headAheadOfBase,
      latestReview: input.latestReview,
    }),
  };
}

// The base SHA pinned into a Verify launch: the merge-base of the run's base branch and the
// head under review, so the (base SHA, head SHA) pointer pair identifies the exact diff even if
// the base branch advances while Verify runs.
export async function pinnedBaseSha(
  worktree: string,
  baseBranch: string,
  headSha: string,
): Promise<string> {
  const result = await git(worktree, ["merge-base", baseBranch, headSha]);
  const baseSha = result.stdout.trim();
  if (result.code !== 0 || !baseSha) {
    throw new ServiceError(
      409,
      `could not resolve merge-base of ${baseBranch} and ${headSha}: ${result.stderr.trim()}`,
    );
  }
  return baseSha;
}
