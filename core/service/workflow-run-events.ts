import type { EventRow } from "../store.ts";
import * as S from "../store.ts";

// Project every PR close route, including merge, onto the same run-scoped close trigger. The event
// wakes a parent blocked in `workflow next --watch`; workflow-runs owns lifecycle reconciliation.
export function projectWorkflowRunClosed(
  repoId: number,
  pullNumber: number,
  actor: string,
  source: EventRow,
): void {
  const run = S.runningWorkflowRunForPull(repoId, pullNumber);
  if (!run) return;
  S.emitWorkflowEvent(repoId, "workflow_run.closed", actor, {
    id: run.id,
    number: pullNumber,
    pr_number: pullNumber,
    parent_session_id: run.parent_session_id,
    source_event_id: source.id,
    source_event_type: source.type,
  });
}
