// Whether a Workflow run has ended, for every surface that shows a run.
//
// A run's end is its linked PR being closed or merged; the run row records no terminal state, so
// there is nothing else to read. The surfaces share this rather than each restating it, for the
// same reason core shares the SQL predicate behind it: a badge that calls a run finished while the
// duration keeps ticking is two answers to one question.

import type { WorkflowRunState } from "@/api/types";

export function workflowRunEnded(state: WorkflowRunState): boolean {
  return state.pr_closed || state.pr_merged;
}
