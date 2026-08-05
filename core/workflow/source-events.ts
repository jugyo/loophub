import { workflowStepSessionIds } from "./herdr-agents.ts";

/**
 * What a Workflow run reads off the ordinary source events its subjects write.
 *
 * A run no longer selects those rows itself: it is woken by a ping and reads its state. What is
 * left here are the two questions the stored payload still answers — which producers write the
 * stable ids the observation trail reads, and whether a given write was the run's own.
 *
 * This module is pure: it is handed every lookup it needs.
 */

/**
 * The version of the source payload contract. A source event carrying it holds the stable ids and
 * producer session id a reader can rely on; rows written before the cutover lack it, which is how
 * the run's observation trail tells the two apart.
 */
export const SOURCE_PAYLOAD_VERSION = 1;

/** The session identity of a run, as the echo check reads it off the run row. */
export interface WorkflowRunSessions {
  parent_session_id: string | null;
  step_sessions_json: string;
}

/**
 * Whether a source event was written by the run's own parent or one of the children it launched.
 *
 * Execute answers a diff feedback thread by replying to it. Waking the parent on that reply would
 * deliver the run's own answer straight back to the child that wrote it, so the run's own writes
 * never become a wake-up.
 */
export function isWorkflowRunOwnSession(
  run: WorkflowRunSessions,
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
