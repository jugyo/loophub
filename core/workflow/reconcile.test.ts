import { describe, expect, test } from "vitest";
import {
  reconcileWorkflow,
  WORKFLOW_REWORK_LIMIT,
  type WorkflowNextAction,
  type WorkflowReconcileInput,
  workflowActionPlan,
} from "./reconcile.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function observed(
  patch: Partial<WorkflowReconcileInput> = {},
): WorkflowReconcileInput {
  return {
    status: "running",
    prClosed: false,
    currentStep: "execute",
    activeStep: null,
    needsHumanReason: null,
    awaitingHuman: false,
    costLimitIncreaseRequired: false,
    reworkCount: 0,
    reworkLimit: WORKFLOW_REWORK_LIMIT,
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

  test("escalates instead of requesting a ninth rework", () => {
    const requestChanges = observed({
      currentStep: "verify",
      activeStep: "verify",
      reworkCount: WORKFLOW_REWORK_LIMIT,
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

  test("requests the held review after a human increases the rework limit", () => {
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "verify",
          reworkCount: 8,
          reworkLimit: 16,
          wake: { kind: "rework_limit_increased" },
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
    ).toMatchObject({ action: "request_rework", review_id: 10 });
  });

  test("recovers from a rework-limit escalation through a human instruction", () => {
    // `escalate-human` records the notification without holding the run, so the human
    // instruction reaches Execute by delivery alone — no resume, no rework count reset.
    expect(
      reconcileWorkflow(
        observed({
          currentStep: "verify",
          activeStep: "verify",
          reworkCount: WORKFLOW_REWORK_LIMIT,
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
          reworkCount: WORKFLOW_REWORK_LIMIT,
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
    expect(reconcileWorkflow(observed({ prClosed: true }))).toMatchObject({
      action: "complete",
    });
  });

  test("completes the run once the linked PR is closed", () => {
    expect(reconcileWorkflow(observed({ prClosed: true }))).toMatchObject({
      action: "complete",
    });
  });

  // Nothing observable can still change a terminal run, so PR completion outranks every other
  // state — a pending receipt, a human hold, a merge conflict, or an unaddressed review.
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
      reconcileWorkflow(observed({ ...patch, prClosed: true })),
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
        execution_context: {
          current_step: "execute",
          active_step: null,
          current_head: HEAD,
          needs_human_reason: null,
          awaiting_human: false,
        },
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
      { kind: "diff_feedback", threadId: 73, commentId: 108 },
      {
        action: "deliver",
        delivery_reason: "diff_feedback",
        thread_id: 73,
        comment_id: 108,
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
          prClosed: true,
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

  // #1828: the increase itself is the human's continuation decision, so a run still held when it
  // lands must resume the step the cost hold interrupted.
  function costIncreaseWake(patch: Partial<WorkflowReconcileInput> = {}) {
    return observed({
      needsHumanReason: "Cost limit exceeded",
      awaitingHuman: true,
      wake: { kind: "cost_limit_increased" },
      ...patch,
    });
  }

  test("resumes an interrupted Execute after a human increased the cost limit", () => {
    expect(
      reconcileWorkflow(costIncreaseWake({ activeStep: "execute" })),
    ).toMatchObject({
      action: "deliver",
      delivery_reason: "cost_limit_increased",
      transition: "resume_execute",
    });
  });

  test("launches a fresh Verify after a human increased the cost limit", () => {
    expect(
      reconcileWorkflow(
        costIncreaseWake({ currentStep: "verify", activeStep: "verify" }),
      ),
    ).toMatchObject({
      action: "launch_verify",
      transition: "resume_verify",
    });
  });

  test("keeps waiting when the increased cost limit is already exceeded", () => {
    expect(
      reconcileWorkflow(
        costIncreaseWake({
          activeStep: "execute",
          costLimitIncreaseRequired: true,
        }),
      ),
    ).toMatchObject({ action: "wait" });
  });

  test("keeps waiting when a cost limit increase has no interrupted step", () => {
    expect(reconcileWorkflow(costIncreaseWake())).toMatchObject({
      action: "wait",
    });
  });

  // A parent that increased the limit itself resumes the run in the same turn, so its own wake sees
  // an unheld run and must not deliver a second re-check instruction.
  test("does not resume twice when the parent already cleared the hold", () => {
    expect(
      reconcileWorkflow(
        observed({
          activeStep: "execute",
          wake: { kind: "cost_limit_increased" },
        }),
      ),
    ).toMatchObject({ action: "wait" });
  });
});

describe("workflowActionPlan", () => {
  const context = { repo: "me/repo", run: 42, issue: 7, pr: 8 };
  const plan = (action: WorkflowNextAction) =>
    workflowActionPlan(action, context);

  test("returns ordered mechanical commands for launch, advance, rework, and cost hold", () => {
    expect(
      plan({ action: "launch_execute", reason: "start" }).commands,
    ).toEqual([
      {
        command: "lh",
        args: [
          "workflow",
          "launch-step",
          "--repo",
          "me/repo",
          "--run",
          "42",
          "--step",
          "execute",
        ],
      },
    ]);
    expect(
      plan({ action: "advance_and_verify", reason: "done" }).commands.map(
        ({ args }) => args[1],
      ),
    ).toEqual(["run", "launch-step"]);
    expect(
      plan({
        action: "request_rework",
        reason: "changes",
        review_id: 9,
      }).commands.at(-1)?.args,
    ).toContain("orchestrator: address review 9");
    expect(
      plan({ action: "cost_hold", reason: "cost", event_id: 11 }).commands[0]
        ?.args,
    ).toContain("11");
  });

  test("reacts to a diff comment before delivering its fixed instruction", () => {
    const diffFeedback = plan({
      action: "deliver",
      reason: "new comment",
      delivery_reason: "diff_feedback",
      thread_id: 73,
      comment_id: 108,
    });
    expect(diffFeedback).toMatchObject({
      boundary: "mechanical",
      after: "watch",
    });
    expect(diffFeedback.commands).toHaveLength(2);
    expect(diffFeedback.commands[0]).toEqual({
      command: "lh",
      args: [
        "pr",
        "feedback",
        "react",
        "108",
        "--pr",
        "8",
        "--emoji",
        "👀",
        "--repo",
        "me/repo",
      ],
    });
    expect(diffFeedback.commands[1]?.input).toBeUndefined();
    expect(diffFeedback.commands[1]?.args).toContain(
      "orchestrator: address diff feedback thread 73 comment 108",
    );
  });

  test("reacts to a PR comment before delivering its fixed instruction", () => {
    const comment = plan({
      action: "deliver",
      reason: "new PR comment",
      delivery_reason: "pr_comment",
      comment_id: 19,
    });
    expect(comment).toMatchObject({ boundary: "mechanical", after: "watch" });
    expect(comment.commands).toHaveLength(2);
    expect(comment.commands[0]).toEqual({
      command: "lh",
      args: [
        "pr",
        "comment",
        "react",
        "19",
        "--pr",
        "8",
        "--emoji",
        "👀",
        "--repo",
        "me/repo",
      ],
    });
    expect(comment.commands[1]?.input).toBeUndefined();
    expect(comment.commands[1]?.args).toContain(
      "orchestrator: address PR comment 19",
    );
  });

  test("makes parent and human judgement boundaries explicit", () => {
    const github = plan({
      action: "read_github_reference",
      reason: "feedback",
      event_id: 12,
      references: ["repos/me/repo/issues/comments/3"],
    });
    expect(github).toMatchObject({
      boundary: "parent_judgement",
      decision: {
        inputs: ["repos/me/repo/issues/comments/3"],
      },
    });
    // Both verdicts are submitted as parent inputs; nothing here asks the parent to fetch an action.
    expect(github.decision?.submit?.args).toEqual([
      "workflow",
      "instruction",
      "42",
      "--repo",
      "me/repo",
      "--event",
      "12",
      "--requires-changes",
      "<true|false>",
      "--json",
    ]);

    const asked = plan({
      action: "ask_human",
      reason: "Current HEAD could not be resolved.",
      question_reason: "head_unresolved",
    });
    expect(asked).toMatchObject({
      boundary: "human_judgement",
      after: "stop",
      decision: { question: "Current HEAD could not be resolved." },
    });
    expect(asked.decision?.submit?.args).toEqual([
      "workflow",
      "instruction",
      "42",
      "--repo",
      "me/repo",
      "--note",
      "<human answer>",
      "--json",
    ]);
  });

  test("encodes delivery, escalation, wait, and completion without hidden procedures", () => {
    expect(
      plan({
        action: "deliver",
        reason: "continue",
        delivery_reason: "human_instruction",
        transition: "resume_execute",
      }),
    ).toMatchObject({
      boundary: "parent_judgement",
      commands: [{}, { input: { argument: "--text" } }],
      after: "watch",
    });
    expect(
      plan({
        action: "escalate",
        reason: "limit",
        escalation_reason: "execute_request",
      }).commands[0],
    ).toMatchObject({ input: { argument: "--reason" } });
    expect(
      plan({
        action: "escalate",
        reason: "request",
        escalation_reason: "execute_request",
        execution_context: {
          current_step: "execute",
          active_step: "execute",
          current_head: HEAD,
          needs_human_reason: null,
          awaiting_human: false,
        },
      }),
    ).toMatchObject({
      boundary: "parent_judgement",
      decision: {
        inputs: ["escalation reason", "execution context"],
      },
    });
    expect(plan({ action: "wait", reason: "waiting" })).toMatchObject({
      commands: [],
      after: "watch",
    });
    expect(plan({ action: "complete", reason: "merged" })).toMatchObject({
      commands: [],
      after: "stop",
    });
  });
});
