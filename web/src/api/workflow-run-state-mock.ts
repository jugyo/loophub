// Test helper: a Workflow run state with every field observed and nothing pending. Component tests
// override only the fields their case is about, so a new field on the wire shape lands here once
// instead of in every fixture.
import type { WorkflowRunState } from "@/api/types";

export function makeWorkflowRunState(
  partial: Partial<WorkflowRunState> = {},
): WorkflowRunState {
  return {
    state_version: 1,
    id: 7,
    workflow_id: 3,
    workflow_name: "standard",
    status: "running",
    current_step: "execute",
    active_step: null,
    active_session_id: null,
    active_verify_head_sha: null,
    last_turn_done_at: null,
    turn_done_for_active_execute: false,
    verify_launched_after_turn_done: true,
    issue_number: 42,
    pr_number: 99,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ended_at: null,
    head_sha: null,
    head_ahead_of_base: false,
    head_ahead_of_latest_review: false,
    latest_review: null,
    verification_status: "unverified",
    unaddressed_out_of_band_reviews: [],
    steps: {
      execute: { complete: false, missing: [] },
      verify: { complete: false, missing: [], latest_review: null },
    },
    latest_issue_comment: null,
    latest_pull_comment: null,
    unaddressed_diff_feedback: [],
    github_feedback: [],
    pr_merged: false,
    pr_closed: false,
    merge_conflict: false,
    done: false,
    needs_human_reason: null,
    awaiting_human: false,
    pending_effect_receipt: null,
    rework_count: 0,
    rework_limit: 8,
    cost_increment_usd: 30,
    cost_limit_usd: 30,
    cost_limit_increase_available: false,
    total_cost: { cost_usd: null, cost_status: "not_recorded" },
    ...partial,
  };
}
