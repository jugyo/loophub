import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { EventRow } from "./store.ts";

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

function significanceOf(
  type: string,
  payload: Record<string, unknown> = {},
  reviewVerdict: string | null = null,
) {
  return serialize.workflowRunHistoryEventJSON(
    eventRow(type, payload),
    null,
    reviewVerdict,
  ).significance;
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
