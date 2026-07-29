import type { EventRow } from "../store.ts";
import * as S from "../store.ts";
import { workflowStepSessionIds } from "../workflow/herdr-agents.ts";

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

/** Whether a session is the run's parent or one of the children it launched. */
function belongsToRun(
  run: S.WorkflowRunRow,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  return (
    sessionId === run.parent_session_id ||
    workflowStepSessionIds(run.step_sessions_json, "execute").includes(
      sessionId,
    ) ||
    workflowStepSessionIds(run.step_sessions_json, "verify").includes(sessionId)
  );
}

// Project a diff feedback comment onto the run that owns the PR, so its parent wakes on the same
// `workflow_run` cursor it already watches and hands the comment to Execute (#2045). Only the ids
// travel: the comment stays canonical in the DB, which Execute reads back with `lh pr feedback`.
//
// Comments written by the run's own sessions are not projected. Execute answers a thread by
// replying to it, and waking the parent on that reply would deliver the run's own answer straight
// back to the child that wrote it.
export function projectWorkflowRunDiffFeedback(input: {
  repoId: number;
  prNumber: number;
  actor: string;
  sessionId: string | null | undefined;
  source: EventRow;
  threadId: number;
  commentId: number;
}): void {
  const run = S.runningWorkflowRunForPull(input.repoId, input.prNumber);
  if (!run?.parent_session_id) return;
  if (belongsToRun(run, input.sessionId)) return;
  S.emitWorkflowEvent(input.repoId, "workflow_run.diff_feedback", input.actor, {
    id: run.id,
    number: input.prNumber,
    pr_number: input.prNumber,
    parent_session_id: run.parent_session_id,
    source_event_id: input.source.id,
    source_event_type: input.source.type,
    thread_id: input.threadId,
    comment_id: input.commentId,
  });
}
