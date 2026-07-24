import { describe, expect, test } from "vitest";
import { reconcileWorkflow, type WorkflowReconcileInput } from "./reconcile.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function observed(
  patch: Partial<WorkflowReconcileInput> = {},
): WorkflowReconcileInput {
  return {
    status: "running",
    prMerged: false,
    currentStep: "execute",
    activeStep: null,
    needsHumanReason: null,
    awaitingHuman: false,
    costLimitIncreaseRequired: false,
    reworkCount: 0,
    reworkLimit: 3,
    pendingEffectReceipt: null,
    unaddressedOutOfBandReviews: [],
    currentHead: HEAD,
    mergeConflict: false,
    turnDoneForActiveExecute: false,
    verifyLaunchedAfterTurnDone: true,
    wake: null,
    steps: {
      execute: { complete: false, missing: ["head equals base"] },
      verify: {
        complete: false,
        missing: ["no workflow review pinned to current head"],
        latest_review: null,
      },
    },
    ...patch,
  };
}

describe("reconcileWorkflow", () => {
  test("launches Execute when the initial run has no active child", () => {
    expect(reconcileWorkflow(observed())).toMatchObject({
      action: "launch_execute",
    });
  });

  test("waits while the active Execute child has not declared turn done", () => {
    expect(
      reconcileWorkflow(observed({ activeStep: "execute" })),
    ).toMatchObject({ action: "wait" });
  });

  test("advances from Execute and launches Verify after turn done with a new HEAD", () => {
    expect(
      reconcileWorkflow(
        observed({
          activeStep: "execute",
          turnDoneForActiveExecute: true,
          steps: {
            execute: { complete: true, missing: [] },
            verify: {
              complete: false,
              missing: ["no workflow review pinned to current head"],
              latest_review: null,
            },
          },
        }),
      ),
    ).toMatchObject({
      action: "advance_and_verify",
    });
  });

  test("launches a fresh Verify directly for continuing work already at Verify", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "execute",
          turnDoneForActiveExecute: true,
          steps: {
            execute: { complete: true, missing: [] },
            verify: {
              complete: false,
              missing: ["no workflow review pinned to current head"],
              latest_review: {
                id: 8,
                event: "pass",
                headSha: OLD,
                fresh: false,
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      action: "launch_verify",
    });
  });

  test("waits for turn done while continuing Execute work has made a review stale", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "execute",
          steps: {
            execute: { complete: true, missing: [] },
            verify: {
              complete: false,
              missing: ["no workflow review pinned to current head"],
              latest_review: {
                id: 8,
                event: "pass",
                headSha: OLD,
                fresh: false,
              },
            },
          },
        }),
      ),
    ).toMatchObject({ action: "wait" });
  });

  test("waits while Verify is already active after an earlier turn done", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "verify",
          turnDoneForActiveExecute: true,
          steps: {
            execute: { complete: true, missing: [] },
            verify: {
              complete: false,
              missing: ["no workflow review pinned to current head"],
              latest_review: null,
            },
          },
        }),
      ),
    ).toMatchObject({ action: "wait" });
  });

  test("launches a fresh Verify when Execute committed again after the active Verify reviewed", () => {
    // The Verify child submitted its review and went idle, then Execute pushed a new HEAD and
    // declared turn done. `active_step` still reads "verify", but nobody is reviewing the new
    // HEAD, so waiting would wedge the run (#1857).
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "verify",
          turnDoneForActiveExecute: true,
          verifyLaunchedAfterTurnDone: false,
          steps: {
            execute: { complete: true, missing: [] },
            verify: {
              complete: false,
              missing: ["no workflow review pinned to current head"],
              latest_review: {
                id: 12,
                event: "pass",
                headSha: OLD,
                fresh: false,
              },
            },
          },
        }),
      ),
    ).toMatchObject({ action: "launch_verify" });
  });

  test("waits while the Verify launched for the latest turn done has not reviewed yet", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "verify",
          turnDoneForActiveExecute: true,
          steps: {
            execute: { complete: true, missing: [] },
            verify: {
              complete: false,
              missing: ["no workflow review pinned to current head"],
              latest_review: {
                id: 12,
                event: "request_changes",
                headSha: OLD,
                fresh: false,
              },
            },
          },
        }),
      ),
    ).toMatchObject({ action: "wait" });
  });

  test("delivers a no-progress diagnosis after turn done without a new HEAD", () => {
    expect(
      reconcileWorkflow(
        observed({
          activeStep: "execute",
          turnDoneForActiveExecute: true,
        }),
      ),
    ).toMatchObject({
      action: "deliver",
      delivery_reason: "no_progress",
    });
  });

  test("keeps repeated no-progress turns visible for operator judgement", () => {
    expect(
      reconcileWorkflow(
        observed({
          activeStep: "execute",
          turnDoneForActiveExecute: true,
        }),
      ),
    ).toMatchObject({
      action: "deliver",
      delivery_reason: "no_progress",
    });
  });

  test("requests rework for a fresh request_changes review", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "verify",
          steps: {
            execute: {
              complete: false,
              missing: [
                "head has not advanced past review #9 (request_changes)",
              ],
            },
            verify: {
              complete: true,
              missing: [],
              latest_review: {
                id: 9,
                event: "request_changes",
                headSha: HEAD,
                fresh: true,
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      action: "request_rework",
      review_id: 9,
    });
  });

  test("escalates instead of requesting a fourth rework", () => {
    const requestChanges = observed({
      currentStep: "verify",
      activeStep: "verify",
      reworkCount: 3,
      steps: {
        execute: {
          complete: false,
          missing: ["head has not advanced past review #10 (request_changes)"],
        },
        verify: {
          complete: true,
          missing: [],
          latest_review: {
            id: 10,
            event: "request_changes",
            headSha: HEAD,
            fresh: true,
          },
        },
      },
    });

    expect(reconcileWorkflow(requestChanges)).toMatchObject({
      action: "escalate",
      escalation_reason: "rework_limit",
      review_id: 10,
    });
  });

  test("recovers from a rework-limit escalation through a human instruction", () => {
    // `escalate-human` records the notification without holding the run, so the human
    // instruction reaches Execute by delivery alone — no resume, no rework count reset.
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "verify",
          reworkCount: 3,
          wake: { kind: "human_instruction" },
          steps: {
            execute: {
              complete: false,
              missing: [
                "head has not advanced past review #10 (request_changes)",
              ],
            },
            verify: {
              complete: true,
              missing: [],
              latest_review: {
                id: 10,
                event: "request_changes",
                headSha: HEAD,
                fresh: true,
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      action: "deliver",
      delivery_reason: "human_instruction",
      transition: null,
    });

    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "execute",
          reworkCount: 3,
          turnDoneForActiveExecute: true,
          steps: {
            execute: { complete: true, missing: [] },
            verify: {
              complete: false,
              missing: ["no workflow review pinned to current head"],
              latest_review: {
                id: 10,
                event: "request_changes",
                headSha: OLD,
                fresh: false,
              },
            },
          },
        }),
      ),
    ).toMatchObject({ action: "launch_verify" });
  });

  test("waits on a fresh pass and while the run is held for a human", () => {
    const freshPass = observed({
      currentStep: "verify",
      activeStep: "verify",
      steps: {
        execute: {
          complete: false,
          missing: ["head has not advanced past review #11 (pass)"],
        },
        verify: {
          complete: true,
          missing: [],
          latest_review: {
            id: 11,
            event: "pass",
            headSha: HEAD,
            fresh: true,
          },
        },
      },
    });
    expect(reconcileWorkflow(freshPass)).toMatchObject({ action: "wait" });
    expect(
      reconcileWorkflow(
        observed({
          needsHumanReason: "Cost limit exceeded",
          awaitingHuman: true,
          mergeConflict: true,
        }),
      ),
    ).toMatchObject({ action: "wait" });
  });

  test("waits while an effect receipt remains pending", () => {
    expect(
      reconcileWorkflow(
        observed({
          pendingEffectReceipt: {
            event_id: 41,
            effect: "notify-parent",
            status: "pending",
            claimed_at: "2026-07-23T00:00:00.000Z",
          },
        }),
      ),
    ).toMatchObject({
      action: "wait",
    });
  });

  test("delivers the oldest unaddressed out-of-band review with its id", () => {
    expect(
      reconcileWorkflow(
        observed({
          activeStep: "verify",
          unaddressedOutOfBandReviews: [
            { id: 21, verdict: "feedback" },
            { id: 22, verdict: "request_changes" },
          ],
        }),
      ),
    ).toMatchObject({
      action: "deliver",
      delivery_reason: "out_of_band_review",
      review_id: 21,
    });
  });

  test("delivers merge conflict resolution through the Execute path", () => {
    expect(reconcileWorkflow(observed({ mergeConflict: true }))).toMatchObject({
      action: "deliver",
      delivery_reason: "merge_conflict",
    });
  });

  test("completes the run once the linked PR is merged", () => {
    expect(reconcileWorkflow(observed({ prMerged: true }))).toMatchObject({
      action: "complete",
    });
  });

  // Nothing observable can still change what shipped, so merge outranks every other state — a
  // pending receipt, a human hold, a merge conflict, or an unaddressed review.
  test.each<[string, Partial<WorkflowReconcileInput>]>([
    [
      "a pending effect receipt",
      {
        pendingEffectReceipt: {
          event_id: 41,
          effect: "notify-parent",
          status: "pending",
          claimed_at: "2026-07-23T00:00:00.000Z",
        },
      },
    ],
    [
      "a human hold",
      { needsHumanReason: "Cost limit exceeded", awaitingHuman: true },
    ],
    ["a merge conflict", { mergeConflict: true }],
    [
      "an unaddressed out-of-band review",
      { unaddressedOutOfBandReviews: [{ id: 21, verdict: "feedback" }] },
    ],
    ["an unresolved HEAD", { currentHead: null }],
    ["a human instruction", { wake: { kind: "human_instruction" } }],
  ])("completes a merged run despite %s", (_label, patch) => {
    expect(
      reconcileWorkflow(observed({ ...patch, prMerged: true })),
    ).toMatchObject({ action: "complete" });
  });

  test("asks a human when the current HEAD cannot be observed", () => {
    expect(reconcileWorkflow(observed({ currentHead: null }))).toMatchObject({
      action: "ask_human",
      question_reason: "head_unresolved",
    });
  });

  test.each([
    [
      { kind: "execute_escalation", reason: "Need product guidance" },
      {
        action: "escalate",
        escalation_reason: "execute_request",
        reason: "Need product guidance",
      },
    ],
    [
      {
        kind: "github_reference",
        eventId: 77,
        references: ["repos/me/repo/issues/comments/9"],
      },
      {
        action: "read_github_reference",
        event_id: 77,
        references: ["repos/me/repo/issues/comments/9"],
      },
    ],
    [
      { kind: "github_feedback" },
      { action: "deliver", delivery_reason: "github_feedback" },
    ],
    [
      { kind: "cost_exceeded", eventId: 91 },
      { action: "cost_hold", event_id: 91 },
    ],
    [
      { kind: "out_of_band_review", reviewId: 42 },
      {
        action: "deliver",
        delivery_reason: "out_of_band_review",
        review_id: 42,
      },
    ],
    [
      { kind: "human_instruction" },
      {
        action: "deliver",
        delivery_reason: "human_instruction",
        transition: null,
      },
    ],
  ] as const)("returns the action represented by wake input", (wake, action) => {
    expect(reconcileWorkflow(observed({ wake }))).toMatchObject(action);
  });

  test("resumes a human hold before delivering a human instruction", () => {
    expect(
      reconcileWorkflow(
        observed({
          needsHumanReason: "Waiting for product guidance",
          awaitingHuman: true,
          wake: { kind: "human_instruction" },
        }),
      ),
    ).toMatchObject({
      action: "deliver",
      delivery_reason: "human_instruction",
      transition: "resume_execute",
    });
  });

  // Detection re-emits `workflow_run.cost_exceeded` while the parent is away (#1844), so a drained
  // replay must still reach `cost-hold` even though the hold it asks for is already established.
  // The command's (run, limit) receipt is what keeps the effects one-time, not this decision.
  test("holds for cost on every cost-exceeded wake, including after the hold", () => {
    expect(
      reconcileWorkflow(
        observed({
          needsHumanReason: "Cost limit exceeded",
          awaitingHuman: true,
          costLimitIncreaseRequired: true,
          wake: { kind: "cost_exceeded", eventId: 92 },
        }),
      ),
    ).toMatchObject({ action: "cost_hold", event_id: 92 });
  });

  test("completes a merged run instead of holding for cost", () => {
    expect(
      reconcileWorkflow(
        observed({
          prMerged: true,
          wake: { kind: "cost_exceeded", eventId: 93 },
        }),
      ),
    ).toMatchObject({ action: "complete" });
  });

  test("does not resume a cost hold before its limit is increased", () => {
    expect(
      reconcileWorkflow(
        observed({
          needsHumanReason: "Cost limit exceeded",
          awaitingHuman: true,
          costLimitIncreaseRequired: true,
          wake: { kind: "human_instruction" },
        }),
      ),
    ).toMatchObject({
      action: "wait",
    });
  });
});
