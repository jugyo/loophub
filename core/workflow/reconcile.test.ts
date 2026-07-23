import { describe, expect, test } from "vitest";
import { reconcileWorkflow, type WorkflowReconcileInput } from "./reconcile.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function observed(
  patch: Partial<WorkflowReconcileInput> = {},
): WorkflowReconcileInput {
  return {
    status: "running",
    currentStep: "execute",
    activeStep: null,
    needsHumanReason: null,
    awaitingHuman: false,
    reworkCount: 0,
    reworkLimit: 3,
    pendingEffectReceipt: null,
    unaddressedOutOfBandReviews: [],
    currentHead: HEAD,
    headAheadOfBase: false,
    mergeConflict: false,
    turnDoneForActiveExecute: false,
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
          headAheadOfBase: true,
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
      transition: "advance_to_verify",
    });
  });

  test("launches a fresh Verify directly for continuing work already at Verify", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "execute",
          headAheadOfBase: true,
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
      action: "advance_and_verify",
      transition: null,
    });
  });

  test("waits for turn done while continuing Execute work has made a review stale", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "execute",
          headAheadOfBase: true,
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
          headAheadOfBase: true,
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

  test("requests rework for a fresh request_changes review", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "verify",
          headAheadOfBase: true,
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
      headAheadOfBase: true,
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

  test("waits on a fresh pass and while the run is held for a human", () => {
    const freshPass = observed({
      currentStep: "verify",
      activeStep: "verify",
      headAheadOfBase: true,
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

  test("asks a human when the current HEAD cannot be observed", () => {
    expect(reconcileWorkflow(observed({ currentHead: null }))).toMatchObject({
      action: "ask_human",
      question_reason: "head_unresolved",
    });
  });
});
