import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type {
  CommentRow,
  EventRow,
  GithubPull,
  Repo,
  ReviewCommentRow,
} from "./store.ts";

// Isolate the DB before serialize.ts -> store.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-serialize-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let serialize: typeof import("./serialize.ts");

beforeAll(async () => {
  serialize = await import("./serialize.ts");
});

function eventRow(
  type: string,
  payload: Record<string, unknown> = {},
): EventRow {
  return {
    id: 1,
    repo_id: 1,
    type,
    actor: "workflow",
    payload: JSON.stringify(payload),
    created_at: "2026-07-24T00:00:00Z",
  };
}

function renderedEvent(
  type: string,
  payload: Record<string, unknown> = {},
  reviewVerdict: string | null = null,
) {
  const { label, description, significance } =
    serialize.workflowRunHistoryEventJSON(
      eventRow(type, payload),
      null,
      reviewVerdict,
    );
  return { label, description, significance };
}

function significanceOf(
  type: string,
  payload: Record<string, unknown> = {},
  reviewVerdict: string | null = null,
) {
  return renderedEvent(type, payload, reviewVerdict).significance;
}

// The significance classification is derived from one principle (#1869): flow-skeleton progress and
// deviation is `notable`, phase starts and external input are `default`, and flow-driving
// communication is `routine`. These cases pin each event type to the branch of that principle.
describe("workflowRunHistoryEventJSON significance", () => {
  // A merge conflict stalls the done stage — a flow deviation, so notable (#1869 flips it from the
  // routine classification #1868 gave it under the self-resolve assumption).
  test("merge conflict is notable as a flow deviation", () => {
    expect(significanceOf("workflow_run.merge_conflict")).toBe("notable");
  });

  test("flow-skeleton progress and deviations are notable", () => {
    // Execute finished implementing.
    expect(
      significanceOf("workflow_run.updated", {
        status: "running",
        transition: "advance_to_verify",
      }),
    ).toBe("notable");
    // Verify sent the run back.
    expect(
      significanceOf("workflow_run.updated", {
        status: "running",
        transition: "request_rework",
      }),
    ).toBe("notable");
    // Run finished.
    expect(
      significanceOf("workflow_run.updated", { status: "completed" }),
    ).toBe("notable");
    // Deviations from the normal flow.
    expect(
      significanceOf("workflow_run.updated", {
        status: "running",
        needs_human_reason: "waiting on a human",
      }),
    ).toBe("notable");
    expect(significanceOf("workflow_run.escalated", { reason: "help" })).toBe(
      "notable",
    );
    expect(significanceOf("workflow_run.cost_exceeded")).toBe("notable");
    // Verify completed with a pass; the linked PR merged (terminal).
    expect(
      significanceOf("workflow_run.review_submitted", { review_id: 5 }, "PASS"),
    ).toBe("notable");
    expect(significanceOf("workflow_run.closed", { pr_number: 7 })).toBe(
      "notable",
    );
    expect(significanceOf("workflow_run.merged", { pr_number: 7 })).toBe(
      "notable",
    );
  });

  test("phase starts and external input are default", () => {
    expect(significanceOf("workflow_run.started", { id: 1 })).toBe("default");
    expect(significanceOf("workflow_step.launched", { step: "execute" })).toBe(
      "default",
    );
    expect(
      significanceOf("workflow_run.github_event", { github_number: 3 }),
    ).toBe("default");
    expect(significanceOf("workflow_run.cost_limit_increased")).toBe("default");
    // Unknown/legacy types fall through to the default marker.
    expect(significanceOf("workflow_run.unheard_of")).toBe("default");
  });

  test("flow-driving communication is routine", () => {
    expect(significanceOf("workflow_run.turn_done")).toBe("routine");
    expect(significanceOf("workflow_run.usage_updated")).toBe("routine");
    // Step activation and the human-instructed resume are the parent's own bookkeeping.
    expect(
      significanceOf("workflow_run.updated", {
        status: "running",
        transition: "activate_step",
      }),
    ).toBe("routine");
    expect(
      significanceOf("workflow_run.updated", {
        status: "running",
        needs_human_reason: null,
      }),
    ).toBe("routine");
    // The change-request review row is a duplicate of the request_rework transition, so it drops
    // to routine under the supporting rule.
    expect(
      significanceOf(
        "workflow_run.review_submitted",
        { review_id: 5 },
        "REQUEST_CHANGES",
      ),
    ).toBe("routine");
  });
});

// Every event type the table in serialize.ts defines, plus the unknown-type fallback, pinned to the
// exact `label` / `description` / `significance` the if/else chain produced before #1913 turned it
// into that table. Wording changes are a product decision; this catches them being made by accident.
const RENDERED_EVENT_CASES: Array<{
  name: string;
  type: string;
  payload: Record<string, unknown>;
  reviewVerdict?: string;
  label: string;
  description: string;
  significance: string;
}> = [
  {
    name: "started",
    type: "workflow_run.started",
    payload: { id: 12 },
    label: "Run started",
    description: "Workflow run #12 started.",
    significance: "default",
  },
  {
    name: "started/no-id",
    type: "workflow_run.started",
    payload: {},
    label: "Run started",
    description: "Workflow run # started.",
    significance: "default",
  },
  {
    name: "updated/completed",
    type: "workflow_run.updated",
    payload: { status: "completed", id: 1 },
    label: "Run completed",
    description: "Status: Completed.",
    significance: "notable",
  },
  {
    name: "updated/stopped",
    type: "workflow_run.updated",
    payload: { status: "stopped" },
    label: "Run stopped",
    description: "Status: Stopped.",
    significance: "notable",
  },
  {
    name: "updated/blocked",
    type: "workflow_run.updated",
    payload: { status: "blocked" },
    label: "Run blocked",
    description: "Status: Blocked.",
    significance: "notable",
  },
  {
    name: "updated/needs-human",
    type: "workflow_run.updated",
    payload: {
      status: "running",
      needs_human_reason: "waiting on a human",
      current_step: "execute",
      rework_count: 2,
    },
    label: "Run needs human",
    description:
      "Status: Running. Waiting for a human: waiting on a human Current step: Execute. Rework count: 2.",
    significance: "notable",
  },
  {
    name: "updated/resumed",
    type: "workflow_run.updated",
    payload: { status: "running", needs_human_reason: null, step: "execute" },
    label: "Run resumed",
    description:
      "Status: Running. Human wait cleared; the run may progress again. Current step: Execute.",
    significance: "routine",
  },
  {
    name: "updated/advance",
    type: "workflow_run.updated",
    payload: {
      status: "running",
      transition: "advance_to_verify",
      current_step: "verify",
      rework_count: 0,
    },
    label: "Execute completed",
    description:
      "Execute finished implementing; the run moved on to Verify. Status: Running. Current step: Verify. Rework count: 0.",
    significance: "notable",
  },
  {
    name: "updated/rework",
    type: "workflow_run.updated",
    payload: {
      status: "running",
      transition: "request_rework",
      current_step: "execute",
    },
    label: "Run rework requested",
    description: "Status: Running. Current step: Execute.",
    significance: "notable",
  },
  {
    name: "updated/activate",
    type: "workflow_run.updated",
    payload: {
      status: "running",
      transition: "activate_step",
      current_step: "verify",
    },
    label: "Step agent activated",
    description: "Status: Running. Current step: Verify.",
    significance: "routine",
  },
  {
    name: "updated/plain",
    type: "workflow_run.updated",
    payload: { status: "running" },
    label: "Run state updated",
    description: "Status: Running.",
    significance: "routine",
  },
  {
    name: "updated/empty",
    type: "workflow_run.updated",
    payload: {},
    label: "Run state updated",
    description: "Status: Updated.",
    significance: "notable",
  },
  {
    name: "step.launched",
    type: "workflow_step.launched",
    payload: { step: "execute" },
    label: "Execute step started",
    description: "Execute step execution started.",
    significance: "default",
  },
  {
    name: "step.launched/no-step",
    type: "workflow_step.launched",
    payload: {},
    label: "Workflow step started",
    description: "Workflow step execution started.",
    significance: "default",
  },
  {
    name: "turn_done",
    type: "workflow_run.turn_done",
    payload: {},
    label: "Turn done declared",
    description:
      "Execute declared its turn done. The parent observes HEAD and review state before any transition.",
    significance: "routine",
  },
  {
    name: "escalated",
    type: "workflow_run.escalated",
    payload: { reason: "help" },
    label: "Human guidance requested",
    description: "Execute requested human guidance: help",
    significance: "notable",
  },
  {
    name: "escalated/no-reason",
    type: "workflow_run.escalated",
    payload: {},
    label: "Human guidance requested",
    description: "Execute requested human guidance: No reason recorded.",
    significance: "notable",
  },
  {
    name: "cost_exceeded",
    type: "workflow_run.cost_exceeded",
    payload: { cost_usd: 12.5, limit_usd: 10 },
    label: "Cost limit exceeded",
    description:
      "Run cost $12.50 passed the $10.00 limit. The run holds until the limit is raised.",
    significance: "notable",
  },
  {
    name: "cost_exceeded/partial",
    type: "workflow_run.cost_exceeded",
    payload: { cost_usd: 12.5 },
    label: "Cost limit exceeded",
    description:
      "Run cost passed its limit. The run holds until the limit is raised.",
    significance: "notable",
  },
  {
    name: "cost_limit_increased",
    type: "workflow_run.cost_limit_increased",
    payload: { previous_limit_usd: 10, current_limit_usd: 20 },
    label: "Cost limit raised",
    description: "A human raised the run's cost limit from $10.00 to $20.00.",
    significance: "default",
  },
  {
    name: "cost_limit_increased/partial",
    type: "workflow_run.cost_limit_increased",
    payload: {},
    label: "Cost limit raised",
    description: "A human raised the run's cost limit so it may continue.",
    significance: "default",
  },
  {
    name: "merge_conflict",
    type: "workflow_run.merge_conflict",
    payload: { pr_number: 3 },
    label: "Merge conflict detected",
    description:
      "The linked PR conflicts with its base. The run cannot progress until the conflict is resolved.",
    significance: "notable",
  },
  {
    name: "review/pass",
    type: "workflow_run.review_submitted",
    payload: { review_id: 5 },
    reviewVerdict: "PASS",
    label: "Review passed",
    description:
      "Review #5 passed on the linked PR — Verify cleared this implementation.",
    significance: "notable",
  },
  {
    name: "review/changes",
    type: "workflow_run.review_submitted",
    payload: { review_id: 5 },
    reviewVerdict: "REQUEST_CHANGES",
    label: "Review requested changes",
    description:
      "Review #5 requested changes on the linked PR. The run reworks unless a human steps in.",
    significance: "routine",
  },
  {
    name: "review/unknown",
    type: "workflow_run.review_submitted",
    payload: { review_id: 5 },
    label: "Review submitted",
    description:
      "Review #5 was submitted on the linked PR. Its verdict decides whether the run advances or reworks.",
    significance: "routine",
  },
  {
    name: "review/no-id",
    type: "workflow_run.review_submitted",
    payload: {},
    label: "Review submitted",
    description:
      "A review was submitted on the linked PR. Its verdict decides whether the run advances or reworks.",
    significance: "routine",
  },
  {
    name: "github_event",
    type: "workflow_run.github_event",
    payload: { github_number: 42 },
    label: "GitHub feedback received",
    description: "New review feedback landed on GitHub PR #42.",
    significance: "default",
  },
  {
    name: "github_event/no-number",
    type: "workflow_run.github_event",
    payload: {},
    label: "GitHub feedback received",
    description:
      "New review feedback landed on the linked GitHub pull request.",
    significance: "default",
  },
  {
    name: "closed",
    type: "workflow_run.closed",
    payload: { pr_number: 7 },
    label: "Linked PR closed",
    description: "PR #7 closed — the run's terminal condition.",
    significance: "notable",
  },
  {
    name: "closed/no-number",
    type: "workflow_run.closed",
    payload: {},
    label: "Linked PR closed",
    description: "The linked PR closed — the run's terminal condition.",
    significance: "notable",
  },
  {
    name: "legacy-merged",
    type: "workflow_run.merged",
    payload: { pr_number: 7 },
    label: "Linked PR merged",
    description: "PR #7 merged — the run's terminal condition.",
    significance: "notable",
  },
  {
    name: "legacy-merged/no-number",
    type: "workflow_run.merged",
    payload: {},
    label: "Linked PR merged",
    description: "The linked PR merged — the run's terminal condition.",
    significance: "notable",
  },
  {
    name: "usage_updated",
    type: "workflow_run.usage_updated",
    payload: {},
    label: "Usage updated",
    description: "Agent usage totals for this run were refreshed.",
    significance: "routine",
  },
  {
    name: "unknown",
    type: "workflow_run.unheard_of",
    payload: {},
    label: "Run unheard of",
    description: "Workflow lifecycle event recorded.",
    significance: "default",
  },
  {
    name: "unknown/effect",
    type: "workflow_effect.human_escalation",
    payload: {},
    label: "Effect human escalation",
    description: "Workflow lifecycle event recorded.",
    significance: "default",
  },
];

describe("workflowRunHistoryEventJSON rendering", () => {
  test.each(RENDERED_EVENT_CASES)("$name", ({
    type,
    payload,
    reviewVerdict,
    label,
    description,
    significance,
  }) => {
    expect(renderedEvent(type, payload, reviewVerdict ?? null)).toEqual({
      label,
      description,
      significance,
    });
  });
});

// The row -> wire converters are synchronous and derive their output from the row they are given,
// so they can be pinned here without a git repo — no worktree, no `git` subprocess, no fixture
// repository (#1914). Serializers whose values come from live git state live in
// serialize-status.ts instead.
describe("pure row -> wire serializers", () => {
  test("repoJSON maps a repo row, normalizing its integer flags", () => {
    const repo: Repo = {
      id: 1,
      full_name: "acme/app",
      name: "app",
      owner: "acme",
      local_path: "/repos/app",
      default_branch: "main",
      created_at: "2026-07-01T00:00:00Z",
      archived: 1,
      archived_at: "2026-07-02T00:00:00Z",
      merge_mode: "github_pr",
      favorite: 0,
      favorited_at: null,
      agent_override: 0,
      agent_runtime: null,
      agent_model: null,
      agent_effort: null,
    };
    expect(serialize.repoJSON(repo)).toEqual({
      id: 1,
      name: "app",
      full_name: "acme/app",
      owner: { login: "acme" },
      default_branch: "main",
      local_path: "/repos/app",
      created_at: "2026-07-01T00:00:00Z",
      archived: true,
      archived_at: "2026-07-02T00:00:00Z",
      favorite: false,
      favorited_at: null,
      merge_mode: "github_pr",
      // Derived from full_name + local_path (terminal-launch.ts), so pin its shape, not the digest.
      herdr_session_name: expect.stringMatching(/^acme-app-[0-9a-f]{8}$/),
    });
  });

  test("commentJSON lifts the author into a user object", () => {
    const row: CommentRow = {
      id: 7,
      issue_id: 3,
      author: "reviewer",
      author_type: "agent",
      body: "looks good",
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-04T00:00:00Z",
    };
    expect(serialize.commentJSON(row)).toEqual({
      id: 7,
      user: { login: "reviewer" },
      author_type: "agent",
      body: "looks good",
      created_at: "2026-07-03T00:00:00Z",
      reactions: [],
    });
  });

  test("reviewCommentJSON renames review_id to the wire field and keeps anchors", () => {
    const row: ReviewCommentRow = {
      id: 11,
      issue_id: 3,
      review_id: 5,
      author: "reviewer",
      body: "off by one",
      path: "core/serialize.ts",
      line: 42,
      side: "RIGHT",
      created_at: "2026-07-05T00:00:00Z",
    };
    expect(serialize.reviewCommentJSON(row)).toEqual({
      id: 11,
      pull_request_review_id: 5,
      user: { login: "reviewer" },
      path: "core/serialize.ts",
      line: 42,
      side: "RIGHT",
      body: "off by one",
      created_at: "2026-07-05T00:00:00Z",
    });
  });

  test("githubPullJSON maps a linked GitHub PR and passes null through", () => {
    const row: GithubPull = {
      issue_id: 3,
      number: 99,
      url: "https://github.com/acme/app/pull/99",
      branch: "loophub/pr-3",
      created_by: "agent",
      created_at: "2026-07-06T00:00:00Z",
      github_merged: 1,
      github_merged_at: "2026-07-07T00:00:00Z",
      pushed_sha: "abc123",
    };
    expect(serialize.githubPullJSON(row)).toEqual({
      number: 99,
      url: "https://github.com/acme/app/pull/99",
      branch: "loophub/pr-3",
      created_by: "agent",
      created_at: "2026-07-06T00:00:00Z",
      github_merged: true,
      github_merged_at: "2026-07-07T00:00:00Z",
      pushed_sha: "abc123",
    });
    expect(serialize.githubPullJSON(null)).toBeNull();
  });
});
