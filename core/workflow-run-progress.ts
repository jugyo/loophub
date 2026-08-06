import { ServiceError } from "./errors.ts";
import { git, hasEffectiveDiff, localBranchRef, mergePreview } from "./git.ts";
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
  headAheadOfLatestReview: boolean;
  hasEffectiveDiff: boolean;
  mergeConflict: boolean;
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
  baseRev: string,
  head: string | null,
): Promise<boolean> {
  if (!head) return false;
  try {
    const result = await git(worktree, [
      "rev-list",
      "--count",
      `${baseRev}..${head}`,
    ]);
    return result.code === 0 && Number(result.stdout.trim()) > 0;
  } catch {
    return false;
  }
}

async function conflictsWithBase(
  worktree: string,
  baseRev: string,
  head: string | null,
): Promise<boolean> {
  if (!head) return false;
  return (await mergePreview(worktree, baseRev, head)).conflict;
}

async function hasEffectiveDiffFromBase(
  worktree: string,
  baseRev: string,
  head: string | null,
): Promise<boolean> {
  if (!head) return false;
  return hasEffectiveDiff(worktree, baseRev, head);
}

export async function isHeadAheadOfReview(
  worktree: string,
  review: WorkflowLatestReviewState | null,
  head: string | null,
): Promise<boolean> {
  if (!review?.headSha || !head || review.headSha === head) return false;
  const result = await git(worktree, [
    "merge-base",
    "--is-ancestor",
    review.headSha,
    head,
  ]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new ServiceError(
    422,
    `could not compare Workflow HEAD to review #${review.id}: ${result.stderr.trim()}`,
  );
}

export async function workflowRunProgress(input: {
  worktree: string;
  baseBranch: string;
  latestReview: WorkflowLatestReviewState | null;
}): Promise<WorkflowRunProgress> {
  const currentHead = await worktreeHeadOptional(input.worktree);
  // `baseBranch` is a local branch name; qualify it once so none of the observations below let git
  // resolve a bare name that a `$GIT_DIR/<name>` file, tag or remote-tracking ref could shadow (#12).
  const baseRev = localBranchRef(input.baseBranch);
  const [
    headAheadOfBase,
    headAheadOfLatestReview,
    effectiveDiff,
    mergeConflict,
  ] = await Promise.all([
    isHeadAheadOfBase(input.worktree, baseRev, currentHead),
    isHeadAheadOfReview(input.worktree, input.latestReview, currentHead),
    hasEffectiveDiffFromBase(input.worktree, baseRev, currentHead),
    conflictsWithBase(input.worktree, baseRev, currentHead),
  ]);
  return {
    currentHead,
    headAheadOfBase,
    headAheadOfLatestReview,
    hasEffectiveDiff: effectiveDiff,
    mergeConflict,
    steps: evaluateWorkflowSteps({
      currentHead,
      headAheadOfBase,
      headAheadOfLatestReview,
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
  // `baseBranch` is a local branch name, so qualify it before git resolves it — a bare name can be
  // shadowed by a `$GIT_DIR/<name>` file, a tag or a remote-tracking ref (#12).
  const result = await git(worktree, [
    "merge-base",
    localBranchRef(baseBranch),
    headSha,
  ]);
  const baseSha = result.stdout.trim();
  if (result.code !== 0 || !baseSha) {
    throw new ServiceError(
      409,
      `could not resolve merge-base of ${baseBranch} and ${headSha}: ${result.stderr.trim()}`,
    );
  }
  return baseSha;
}
