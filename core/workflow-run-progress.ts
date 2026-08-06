import { ServiceError } from "./errors.ts";
import {
  describeUnresolvedRevision,
  git,
  hasEffectiveDiff,
  localBranchRef,
  mergePreview,
  revParse,
} from "./git.ts";
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
  // Base is only needed when HEAD is known. Unprovisioned PR worktrees (no checkout yet) skip
  // git base resolution entirely — same as the head-null short-circuits below. When HEAD exists,
  // resolve `refs/heads/<base>` to a SHA so merge-tree / range math never see a bare name that
  // `$GIT_DIR/<name>` can shadow (#12 / #39).
  const baseRev = currentHead
    ? await resolveLocalBaseSha(input.worktree, input.baseBranch)
    : localBranchRef(input.baseBranch);
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
  // Resolve via `refs/heads/<name>` first so a `$GIT_DIR/<name>` pseudo-ref cannot win (#12 / #39).
  const baseTip = await resolveLocalBaseSha(worktree, baseBranch);
  const result = await git(worktree, ["merge-base", baseTip, headSha]);
  const baseSha = result.stdout.trim();
  if (result.code !== 0 || !baseSha) {
    throw new ServiceError(
      409,
      `could not resolve merge-base of ${baseBranch} and ${headSha}: ${result.stderr.trim()}`,
    );
  }
  return baseSha;
}

// Disambiguate a local branch name to the commit at `refs/heads/<name>`. Never falls through to
// git's bare-name resolution (which prefers a stray `$GIT_DIR/<name>` file over the branch).
// On failure, include collision candidates and a fix hint (#39 AC-3) — not a bare "not found".
async function resolveLocalBaseSha(
  worktree: string,
  baseBranch: string,
): Promise<string> {
  const baseRef = localBranchRef(baseBranch);
  const sha = await revParse(worktree, baseRef);
  if (sha) return sha;
  const diagnosis = await describeUnresolvedRevision(worktree, baseRef);
  throw new ServiceError(
    422,
    `could not resolve Workflow base branch '${baseBranch}':\n${diagnosis}`,
  );
}
