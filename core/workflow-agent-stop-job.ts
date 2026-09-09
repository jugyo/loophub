import * as J from "./store/jobs.ts";
import type * as S from "./store.ts";

export const STOP_WORKFLOW_AGENTS_JOB = "workflow_agents.stop";

export function enqueueWorkflowAgentStop(run: S.WorkflowRunRow): number {
  return J.enqueue({
    type: STOP_WORKFLOW_AGENTS_JOB,
    repoId: run.repo_id,
    dedupeKey: `${STOP_WORKFLOW_AGENTS_JOB}:${run.id}`,
    params: { run: run.id },
  });
}
