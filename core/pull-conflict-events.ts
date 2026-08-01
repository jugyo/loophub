import { db } from "./db.ts";
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
  computeState?: (pull: S.OpenPullSweepRow) => Promise<MergeableState>;
}

export interface ConflictSweepResult {
  checked: number;
  emitted: number;
}

// One sweep tick: reconcile every open PR's mergeable state, and for each that just transitioned
// clean -> conflict, fire pull_request.merge_conflict once. State is recorded before the
// transition check so the event fires at most once per transition, even across ticks (see
// recordPullConflictState).
export async function sweepPullConflicts(
  deps: ConflictSweepDeps = {},
): Promise<ConflictSweepResult> {
  const computeState = deps.computeState ?? currentMergeableState;
  const pulls = S.openPulls();
  let emitted = 0;
  for (const pull of pulls) {
    const state = await computeState(pull);
    // "unknown" means the computation itself failed this tick (e.g. a ref lookup error), not an
    // observed PR state. Recording it would overwrite a stored "clean" and permanently consume
    // the clean -> conflict edge — a conflicted PR can never return to clean — so skip the tick.
    if (state === "unknown") continue;
    // Recording the state consumes the clean -> conflict edge, so it must commit with the event it
    // fires: a stored `conflict` whose event was lost leaves every later tick reading
    // conflict -> conflict, and the conflict is never reported.
    if (
      db.transaction(() => {
        const transition = S.recordPullConflictState(
          pull.repo_id,
          pull.number,
          state,
        );
        if (
          !classifyConflictTransition(transition.previous, transition.current)
        )
          return false;
        S.emitEvent(pull.repo_id, "pull_request.merge_conflict", "lh-worker", {
          number: pull.number,
          source_payload_version: SOURCE_PAYLOAD_VERSION,
        });
        return true;
      })
    )
      emitted++;
  }
  return { checked: pulls.length, emitted };
}
