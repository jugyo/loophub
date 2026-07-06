export interface MainMergeUndoFacts {
  merged: boolean;
  baseRef: string;
  requiredBaseRef?: string;
  mergeCommitSha: string | null;
  currentBaseSha: string | null;
  mergeParents: string[] | null;
}

export interface MainMergeUndoStatus {
  can_undo: boolean;
  reason: string | null;
  base_ref: string;
  current_main_sha: string | null;
  merge_commit_sha: string | null;
  previous_main_sha: string | null;
}

export function assessMainMergeUndo(
  facts: MainMergeUndoFacts,
): MainMergeUndoStatus {
  const requiredBaseRef = facts.requiredBaseRef ?? "main";
  const base = {
    base_ref: facts.baseRef,
    current_main_sha: facts.currentBaseSha,
    merge_commit_sha: facts.mergeCommitSha,
    previous_main_sha:
      facts.mergeParents && facts.mergeParents.length >= 1
        ? facts.mergeParents[0]
        : null,
  };

  if (!facts.merged) {
    return { ...base, can_undo: false, reason: "Pull Request is not merged" };
  }
  if (facts.baseRef !== requiredBaseRef) {
    return {
      ...base,
      can_undo: false,
      reason: `Pull Request targets ${facts.baseRef}, not ${requiredBaseRef}`,
    };
  }
  if (!facts.mergeCommitSha) {
    return {
      ...base,
      can_undo: false,
      reason: "Pull Request has no recorded merge commit",
    };
  }
  if (!facts.currentBaseSha) {
    return {
      ...base,
      can_undo: false,
      reason: `${requiredBaseRef} does not resolve`,
    };
  }
  if (!facts.mergeParents) {
    return {
      ...base,
      can_undo: false,
      reason: "Recorded merge commit is not available in git",
    };
  }
  if (facts.currentBaseSha !== facts.mergeCommitSha) {
    return {
      ...base,
      can_undo: false,
      reason: `${requiredBaseRef} now points to ${facts.currentBaseSha}, not the PR merge commit ${facts.mergeCommitSha}`,
    };
  }
  if (facts.mergeParents.length !== 2) {
    return {
      ...base,
      can_undo: false,
      reason: `Recorded commit has ${facts.mergeParents.length} parent(s), not a merge commit`,
    };
  }
  return { ...base, can_undo: true, reason: null };
}
