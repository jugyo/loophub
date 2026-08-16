import type { WorkflowRunState } from "@/api/types";

// A PR merge can become visible before the worker reconciles its Workflow run. Keep that brief,
// valid state from leaking running, hold, or conflict presentation beside the merged terminal state.
export function workflowRunDisplayState(
  state: WorkflowRunState,
): WorkflowRunState {
  if (!state.pr_merged) return state;
  return {
    ...state,
    status: "completed",
    needs_human_reason: null,
    cost_limit_increase_available: false,
    merge_conflict: false,
    done: false,
  };
}
