import { db } from "./db.ts";
import type { GhPrStatus } from "./github.ts";
import type { MergeableState } from "./mergeable.ts";
import { currentMergeableState } from "./pull-mergeable-state.ts";
import * as S from "./store.ts";
import { SOURCE_PAYLOAD_VERSION } from "./workflow/source-events.ts";

// The worker's conflict sweep (#1232): detect when a reviewed, mergeable PR (`clean`) has been
// left waiting for a human merge long enough that a sibling merge advanced its base into a
// conflict, and fire pull_request.merge_conflict once. Detection is a pure edge on the PR's
// mergeable state; the git/DB computation is injected so the transition and idempotency logic
// stay unit-testable without spawning git.
//
// This sweep is an event *source* only: it emits pull_request.merge_conflict and — for a PR under a
// running Workflow run — a run-scoped workflow_run.merge_conflict projection (#1516). What reacts to
// either event — e.g. a Workflow parent polling its run cursor — is the consumer's wiring; the
// worker knows no skill names and launches nothing (that dispatch coupling is what #1232 removes).

// Whether this sweep should fire the conflict event for a state change. Only a clean -> conflict
// edge qualifies: `clean` already requires reviewed && review-passed (see resolveMergeable),
// so this naturally excludes drafts, unreviewed (`blocked`), and diff-free (`no_commits`) PRs — a
// PR still being worked is never `clean` — and avoids re-firing while a PR simply stays
// conflicted.
export function classifyConflictTransition(
  previous: MergeableState | null,
  current: MergeableState,
): boolean {
  return previous === "clean" && current === "conflict";
}

export interface ConflictSweepDeps {
  // Compute a PR's current mergeable state. Defaults to the shared live git/review computation.
  computeState?: (
    pull: S.OpenPullSweepRow,
    previousProjection?: S.CurrentPullStatusProjection | null,
  ) => Promise<MergeableState>;
  // 指定時は同じ repository と base ref の open PR に対象を絞る。periodic fallback は未指定で
  // すべての open PR を再検知する。
  repoId?: number;
  baseRef?: string;
  // GitHub status refreshes target one linked PR immediately; periodic sweeps leave this unset.
  issueId?: number;
  // A fresh GitHub result is cached atomically with its targeted state transition and events.
  githubStatus?: GhPrStatus;
}

export interface ConflictSweepResult {
  checked: number;
  emitted: number;
}

function cachedGithubMergeable(
  issueId: number,
): "mergeable" | "conflicting" | "unknown" | null {
  const cached = S.getGithubPullStatus(issueId);
  if (!cached) return null;
  try {
    const mergeable = (JSON.parse(cached.payload) as { mergeable?: unknown })
      .mergeable;
    return mergeable === "mergeable" ||
      mergeable === "conflicting" ||
      mergeable === "unknown"
      ? mergeable
      : null;
  } catch {
    return null;
  }
}

// One sweep tick: reconcile every open PR's mergeable state, and for each that just transitioned
// clean -> conflict, fire pull_request.merge_conflict once. State is recorded before the
// transition check so the event fires at most once per transition, even across ticks (see
// recordPullConflictState).
export async function sweepPullConflicts(
  deps: ConflictSweepDeps = {},
): Promise<ConflictSweepResult> {
  const computeState = deps.computeState ?? currentMergeableState;
  const pulls = S.openPulls().filter(
    (pull) =>
      (deps.repoId === undefined || pull.repo_id === deps.repoId) &&
      (deps.baseRef === undefined || pull.base_ref === deps.baseRef) &&
      (deps.issueId === undefined || pull.issue_id === deps.issueId),
  );
  let emitted = 0;
  for (const pull of pulls) {
    let localState: MergeableState;
    try {
      localState = await computeState(
        pull,
        S.getCurrentPullStatusProjection(pull.issue_id),
      );
    } catch (error) {
      // A freshly fetched GitHub status is still authoritative when local git is temporarily
      // unreadable. Preserve the existing visible failure for periodic local-only sweeps.
      if (!deps.githubStatus) throw error;
      localState = "unknown";
    }
    // Recording the state consumes the clean -> conflict edge, so it must commit with the event it
    // fires: a stored `conflict` whose event was lost leaves every later tick reading
    // conflict -> conflict, and the conflict is never reported.
    if (
      db.transaction(() => {
        if (deps.githubStatus)
          S.saveGithubPullStatus(
            pull.issue_id,
            JSON.stringify(deps.githubStatus),
          );
        // Read the GitHub signal only after entering the write transaction. A periodic sweep may
        // have computed local state before another process refreshed GitHub; this fresh read keeps
        // that stale local result from overwriting a newly recorded GitHub conflict.
        const githubMergeable = cachedGithubMergeable(pull.issue_id);
        const previous = S.getPullConflictState(pull.repo_id, pull.number);
        const localConflict = localState === "conflict";
        const githubConflict = githubMergeable === "conflicting";
        const state =
          githubConflict || localConflict
            ? "conflict"
            : githubMergeable === "unknown"
              ? (previous ?? localState)
              : localState;
        if (state === "unknown") return false;
        const transition = S.recordPullConflictState(
          pull.repo_id,
          pull.number,
          state,
        );
        // A definite GitHub conflict is an independent edge whenever the shared state was not
        // already conflicting. Local state may legitimately be blocked or no_commits before a run
        // reaches review, so requiring a local clean baseline would consume the remote edge without
        // notifying its workflow.
        const githubConflictTransition =
          githubConflict && transition.previous !== "conflict";
        if (
          !githubConflictTransition &&
          !classifyConflictTransition(transition.previous, transition.current)
        )
          return false;
        const conflictSource =
          localConflict && githubConflict
            ? "both"
            : githubConflict
              ? "github"
              : "local";
        const source = S.emitEvent(
          pull.repo_id,
          "pull_request.merge_conflict",
          "lh-worker",
          {
            number: pull.number,
            source_payload_version: SOURCE_PAYLOAD_VERSION,
            conflict_source: conflictSource,
          },
        );
        const run = S.latestWorkflowRunForPull(pull.repo_id, pull.number);
        if (run?.status === "running") {
          S.emitEvent(
            pull.repo_id,
            "workflow_run.merge_conflict",
            "lh-worker",
            {
              id: run.id,
              number: pull.number,
              parent_session_id: run.parent_session_id,
              pr_number: pull.number,
              source_event_id: source.id,
              source_event_type: source.type,
              conflict_source: conflictSource,
            },
          );
        }
        return true;
      })
    )
      emitted++;
  }
  return { checked: pulls.length, emitted };
}
