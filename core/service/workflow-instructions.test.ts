import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-instructions-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("../store.ts");
let svc: typeof import("../service.ts");

beforeAll(async () => {
  S = await import("../store.ts");
  svc = await import("../service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function fixture(name: string, options: { started?: boolean } = {}) {
  const repoPath = mkdtempSync(join(tmpdir(), "lh-instruction-repo-"));
  const repo = S.createRepo(`me/${name}`, repoPath);
  const issue = S.createIssue(repo.id, "issue", "Issue", "", "me");
  const pr = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pr.id, "feature", "main", "head", null);
  const workflow = S.createWorkflow({
    name: `workflow-${name}`,
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = `${String(repo.id).padStart(8, "0")}-0000-4000-8000-000000000001`;
  S.registerAgentSession(
    parent,
    "lh-workflow",
    parent,
    null,
    "cursor",
    "dev",
    "auto",
    "2000-01-01T00:00:00.000Z",
  );
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: pr.number,
    status: "running",
    currentStep: "execute",
    parentSessionId: parent,
    costIncrementUsd: 5,
    costLimitUsd: 5,
  });
  // The run's start bounds its subscription, so every fixture records it as `workflow start` does.
  // The one that leaves it out asserts the visible error that follows.
  const event =
    options.started === false
      ? null
      : S.emitWorkflowEvent(repo.id, "workflow_run.started", "me", {
          id: run.id,
          workflow_id: workflow.id,
          issue_number: issue.number,
          pr_number: pr.number,
          session_id: parent,
        });
  return {
    repo,
    repoPath,
    run,
    event: event as import("../store.ts").EventRow,
  };
}

function fakeHerdr() {
  const bin = mkdtempSync(join(tmpdir(), "lh-instruction-herdr-"));
  const log = join(bin, "calls.log");
  writeFileSync(
    join(bin, "herdr"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      'if [ "$4" = "send-keys" ] && [ "$HERDR_SEND_FAIL" = "1" ]; then exit 9; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "herdr"), 0o755);
  return { bin, log };
}

// The launch handshake a delivery waits for: the launcher registers the pane, then the parent agent
// declares it reads that pane. Tests that exercise the gate itself do the two steps separately.
function registerParent(
  input: ReturnType<typeof fixture>,
  paneId: string | null = "w1:p1",
) {
  const pane = registerParentPane(input, paneId);
  markParentReady(input);
  return pane;
}

function registerParentPane(
  input: ReturnType<typeof fixture>,
  paneId: string | null = "w1:p1",
  launchedAt = new Date().toISOString(),
) {
  return svc.workflowInstructions.registerParentPane(input.repo.full_name, {
    run: input.run.id,
    launch_id: input.run.parent_session_id as string,
    session_name: "me-repo",
    pane_id: paneId,
    launched_at: launchedAt,
  });
}

function markParentReady(input: ReturnType<typeof fixture>) {
  const ready = S.markWorkflowRunParentReady(input.run.id);
  if (!ready?.parent_ready_at) throw new Error("could not mark parent ready");
  return { run: ready.id, ready_at: ready.parent_ready_at };
}

function herdrCalls(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("parent pane registration records the successful process launch time", () => {
  const input = fixture("parent-launch-time");
  const launchedAt = "2030-07-09T12:34:56.789Z";
  try {
    registerParentPane(input, "w1:p1", launchedAt);
    expect(S.getAgentSession(input.run.parent_session_id!)?.created_at).toBe(
      launchedAt,
    );
  } finally {
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

function instructionResult(event: number) {
  return {
    action: "launch_execute" as const,
    reason: "Execute has not started.",
    instructions: {
      boundary: "mechanical" as const,
      commands: [
        {
          command: "lh" as const,
          args: [
            "workflow",
            "launch-step",
            "--repo",
            "me/repo",
            "--run",
            "1",
            "--step",
            "execute",
          ],
        },
      ],
      decision: null,
      after: "watch" as const,
    },
    observed: {} as never,
    event: { id: event } as never,
  };
}

function emitCommentPair(
  input: ReturnType<typeof fixture>,
  commentId: number,
  marked: boolean,
) {
  const source = S.emitEvent(input.repo.id, "pull_request.commented", "me", {
    number: input.run.pr_number,
    comment_id: commentId,
    author_type: "human",
    ...(marked ? { source_payload_version: 1 } : {}),
  });
  const twin = S.emitEvent(input.repo.id, "workflow_run.pr_comment", "me", {
    id: input.run.id,
    number: input.run.pr_number,
    pr_number: input.run.pr_number,
    parent_session_id: input.run.parent_session_id,
    source_event_id: source.id,
    source_event_type: "pull_request.commented",
    comment_id: commentId,
    author: "me",
    body: "Please rename this.",
  });
  return { source, twin };
}

function instructionReceipt(run: number, event: number) {
  return S.getWorkflowEventEffectWithPrefix(
    run,
    event,
    "workflow.instruction:",
  );
}

test("delivers the existing next decision to only the matching parent pane once", async () => {
  const input = fixture("delivery");
  const fake = fakeHerdr();
  const unrelated = S.registerHerdrPane({
    repoId: input.repo.id,
    launchId: "unrelated-parent",
    paneId: "w1:p9",
    sessionName: "me-repo",
  });
  S.linkHerdrPaneResource({
    repoId: input.repo.id,
    launchId: unrelated.launch_id,
    resourceKind: "workflow_run",
    resourceKey: String(input.run.id + 1),
  });
  S.registerHerdrPane({
    repoId: input.repo.id,
    launchId: "unrelated-executor",
    paneId: "w1:p2",
    sessionName: "me-repo",
  });
  registerParent(input);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(input.event.id));
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "delivered",
      run: input.run.id,
      event: input.event.id,
      pane_id: "w1:p1",
      action: "launch_execute",
    });
    const calls = readFileSync(fake.log, "utf8");
    expect(calls).toContain(
      "pane send-text w1:p1 \u001b[200~workflow instruction:",
    );
    expect(calls).toContain("\u001b[201~");
    expect(calls).toContain('"action":"launch_execute"');
    expect(calls).toContain('"reason":"Execute has not started."');
    expect(calls).toContain("pane send-keys w1:p1 Enter");
    expect(calls).not.toContain("pane send-text w1:p9");
    expect(calls).not.toContain("pane send-text w1:p2");
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(input.event.id);
    expect(
      S.getWorkflowEventEffectWithPrefix(
        input.run.id,
        input.event.id,
        "workflow.instruction:",
      )?.status,
    ).toBe("completed");

    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toEqual({ status: "idle" });
    expect(readFileSync(fake.log, "utf8")).toBe(calls);
    expect(next).toHaveBeenCalledTimes(1);
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

// A registered pane only means the pane exists. Delivering into it while the agent is still starting
// writes text nothing reads, and the delivery still records itself as completed, so the run stalls
// forever (#2156).
test("delivery waits for the parent agent's readiness signal, not just its pane", async () => {
  const input = fixture("unready-parent");
  const fake = fakeHerdr();
  registerParentPane(input);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(input.event.id));
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toEqual({ status: "idle" });
    expect(herdrCalls(fake.log)).toBe("");
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(0);
    expect(
      S.getWorkflowEventEffectWithPrefix(
        input.run.id,
        input.event.id,
        "workflow.instruction:",
      ),
    ).toBeNull();
    expect(next).not.toHaveBeenCalled();

    markParentReady(input);
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "delivered",
      run: input.run.id,
      event: input.event.id,
      pane_id: "w1:p1",
    });
    expect(herdrCalls(fake.log)).toContain("pane send-text w1:p1");
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("a parent that never signals readiness after launch grace fails visibly and is not retried", async () => {
  const input = fixture("never-ready-parent");
  const fake = fakeHerdr();
  registerParentPane(input);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse(input.run.created_at) + 15 * 60_000);
  const next = vi.spyOn(svc.workflowRuns, "next");
  try {
    expect(await svc.workflowInstructions.dispatchPending()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        run: input.run.id,
        error: expect.stringContaining("parent agent readiness timed out"),
      }),
    );
    expect(herdrCalls(fake.log)).toBe("");
    expect(
      S.getWorkflowEventEffectWithPrefix(
        input.run.id,
        input.event.id,
        "workflow.instruction:",
      )?.status,
    ).toBe("pending");
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(0);

    await expect(svc.workflowInstructions.dispatchPending()).resolves.toEqual(
      [],
    );
    expect(herdrCalls(fake.log)).toBe("");
    expect(next).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("a missing parent pane after launch grace fails visibly and is not retried", async () => {
  const input = fixture("missing-parent");
  const fake = fakeHerdr();
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse(input.run.created_at) + 15 * 60_000);
  const next = vi.spyOn(svc.workflowRuns, "next");
  try {
    expect(await svc.workflowInstructions.dispatchPending()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        run: input.run.id,
        error: expect.stringContaining("parent pane registration timed out"),
      }),
    );
    const calls = herdrCalls(fake.log);
    const receipt = S.getWorkflowEventEffectWithPrefix(
      input.run.id,
      input.event.id,
      "workflow.instruction:",
    );
    expect(receipt?.status).toBe("pending");
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(0);

    await expect(svc.workflowInstructions.dispatchPending()).resolves.toEqual(
      [],
    );
    expect(herdrCalls(fake.log)).toBe(calls);
    expect(next).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("an invalid registered parent pane fails visibly and is not retried", async () => {
  const input = fixture("invalid-parent");
  const fake = fakeHerdr();
  registerParent(input, null);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(input.event.id));
  try {
    expect(await svc.workflowInstructions.dispatchPending()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        run: input.run.id,
        error: expect.stringContaining("could not resolve one parent pane"),
      }),
    );
    const calls = herdrCalls(fake.log);
    expect(
      S.getWorkflowEventEffectWithPrefix(
        input.run.id,
        input.event.id,
        "workflow.instruction:",
      )?.status,
    ).toBe("pending");

    await expect(svc.workflowInstructions.dispatchPending()).resolves.toEqual(
      [],
    );
    expect(herdrCalls(fake.log)).toBe(calls);
    expect(next).toHaveBeenCalledTimes(1);
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("queued lifecycle wakes are processed in order and identical decisions are suppressed", async () => {
  const input = fixture("queued-state");
  const latest = S.emitWorkflowEvent(
    input.repo.id,
    "workflow_run.updated",
    "me",
    {
      id: input.run.id,
      issue_number: input.run.issue_number,
      pr_number: input.run.pr_number,
      transition: "activate_step",
      status: "running",
      current_step: "execute",
      rework_count: 0,
      active_step: "execute",
      active_session_id: "execute-session",
    },
  );
  const fake = fakeHerdr();
  registerParent(input);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockImplementation(async (_name, opts) =>
      instructionResult(opts.event as number),
    );
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "delivered",
      event: input.event.id,
    });
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(input.event.id);
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "skipped",
      event: latest.id,
      reason: "Instruction matches the previous state change",
    });
    expect(next).toHaveBeenNthCalledWith(1, input.repo.full_name, {
      run: input.run.id,
      event: input.event.id,
    });
    expect(next).toHaveBeenNthCalledWith(2, input.repo.full_name, {
      run: input.run.id,
      event: latest.id,
    });
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(latest.id);
    expect(
      readFileSync(fake.log, "utf8").match(/pane send-text/g),
    ).toHaveLength(1);
    expect(
      readFileSync(fake.log, "utf8").match(/pane send-keys/g),
    ).toHaveLength(1);
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toEqual({ status: "idle" });
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("an unmarked source advances without a receipt and its legacy twin owns the instruction", async () => {
  const input = fixture("unmarked-source-before");
  const pair = emitCommentPair(input, 9201, false);
  const fake = fakeHerdr();
  registerParent(input);
  S.advanceWorkflowRunEventCursor(input.run.id, input.event.id);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockImplementation(async (_name, opts) =>
      instructionResult(opts.event as number),
    );
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "skipped",
      event: pair.source.id,
      reason: "Event only wakes state observation",
    });
    expect(instructionReceipt(input.run.id, pair.source.id)).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);

    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "delivered",
      event: pair.twin.id,
    });
    expect(instructionReceipt(input.run.id, pair.twin.id)?.status).toBe(
      "completed",
    );
    expect(next).toHaveBeenCalledTimes(2);
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("an unmarked legacy twin still owns the instruction with the cursor after its source", async () => {
  const input = fixture("unmarked-source-between");
  const pair = emitCommentPair(input, 9202, false);
  const fake = fakeHerdr();
  registerParent(input);
  S.advanceWorkflowRunEventCursor(input.run.id, pair.source.id);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(pair.twin.id));
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({ status: "delivered", event: pair.twin.id });
    expect(instructionReceipt(input.run.id, pair.source.id)).toBeNull();
    expect(instructionReceipt(input.run.id, pair.twin.id)?.status).toBe(
      "completed",
    );
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("an unmarked pair is not revisited with the cursor after its twin", async () => {
  const input = fixture("unmarked-source-after");
  const pair = emitCommentPair(input, 9203, false);
  S.advanceWorkflowRunEventCursor(input.run.id, pair.twin.id);
  const next = vi.spyOn(svc.workflowRuns, "next");
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toEqual({ status: "idle" });
    expect(instructionReceipt(input.run.id, pair.source.id)).toBeNull();
    expect(instructionReceipt(input.run.id, pair.twin.id)).toBeNull();
    expect(next).not.toHaveBeenCalled();
  } finally {
    next.mockRestore();
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("a marked source owns the instruction and its late legacy twin creates no receipt", async () => {
  const input = fixture("marked-source-before");
  const pair = emitCommentPair(input, 9204, true);
  const fake = fakeHerdr();
  registerParent(input);
  S.advanceWorkflowRunEventCursor(input.run.id, input.event.id);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(pair.source.id));
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({ status: "delivered", event: pair.source.id });
    expect(instructionReceipt(input.run.id, pair.source.id)?.status).toBe(
      "completed",
    );

    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "skipped",
      event: pair.twin.id,
      reason: "Instruction was superseded by its source event",
    });
    expect(instructionReceipt(input.run.id, pair.twin.id)).toBeNull();
    expect(next).toHaveBeenCalledTimes(2);
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("a marked legacy twin is superseded with the cursor after its source", async () => {
  const input = fixture("marked-source-between");
  const pair = emitCommentPair(input, 9205, true);
  S.advanceWorkflowRunEventCursor(input.run.id, pair.source.id);
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(pair.twin.id));
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "skipped",
      event: pair.twin.id,
      reason: "Instruction was superseded by its source event",
    });
    expect(instructionReceipt(input.run.id, pair.twin.id)).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  } finally {
    next.mockRestore();
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("a marked pair is not revisited with the cursor after its twin", async () => {
  const input = fixture("marked-source-after");
  const pair = emitCommentPair(input, 9206, true);
  S.advanceWorkflowRunEventCursor(input.run.id, pair.twin.id);
  const next = vi.spyOn(svc.workflowRuns, "next");
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toEqual({ status: "idle" });
    expect(instructionReceipt(input.run.id, pair.source.id)).toBeNull();
    expect(instructionReceipt(input.run.id, pair.twin.id)).toBeNull();
    expect(next).not.toHaveBeenCalled();
  } finally {
    next.mockRestore();
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("dispatchPending reports the event that failed after an earlier event was skipped", async () => {
  const input = fixture("skip-then-fail");
  const latest = S.emitWorkflowEvent(
    input.repo.id,
    "workflow_run.updated",
    "me",
    {
      id: input.run.id,
      issue_number: input.run.issue_number,
      pr_number: input.run.pr_number,
      transition: "activate_step",
      status: "running",
      current_step: "execute",
      rework_count: 0,
      active_step: "execute",
      active_session_id: "execute-session",
    },
  );
  const dispatch = vi
    .spyOn(svc.workflowInstructions, "dispatchRun")
    .mockImplementationOnce(async () => {
      S.advanceWorkflowRunEventCursor(input.run.id, input.event.id);
      return {
        status: "skipped",
        run: input.run.id,
        event: input.event.id,
        reason: "No instruction needed",
      };
    })
    .mockRejectedValueOnce(new Error("second event failed"));
  try {
    await expect(svc.workflowInstructions.dispatchPending()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          run: input.run.id,
          event: latest.id,
          error: "second event failed",
        }),
      ]),
    );
  } finally {
    dispatch.mockRestore();
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("dispatchPending measures each run independently", async () => {
  const slow = fixture("slow-pending-run");
  const fast = fixture("fast-pending-run");
  let nowMs = 0;
  const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  const dispatch = vi
    .spyOn(svc.workflowInstructions, "dispatchRun")
    .mockImplementation(async (runId) => {
      if (runId === slow.run.id) {
        nowMs += 100;
        return {
          status: "delivered",
          run: runId,
          event: slow.event.id,
          pane_id: "w1:p1",
          action: "launch_execute",
        };
      }
      if (runId === fast.run.id) {
        nowMs += 5;
        return {
          status: "delivered",
          run: runId,
          event: fast.event.id,
          pane_id: "w1:p2",
          action: "launch_verify",
        };
      }
      return { status: "idle" };
    });
  try {
    const results = await svc.workflowInstructions.dispatchPending();
    expect(results).toContainEqual(
      expect.objectContaining({
        status: "delivered",
        run: slow.run.id,
        durationMs: 100,
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        status: "delivered",
        run: fast.run.id,
        durationMs: 5,
      }),
    );
  } finally {
    dispatch.mockRestore();
    now.mockRestore();
    rmSync(slow.repoPath, { recursive: true, force: true });
    rmSync(fast.repoPath, { recursive: true, force: true });
  }
});

test("an ambiguous send failure leaves a visible pending receipt and is not repeated", async () => {
  const input = fixture("send-failure");
  const fake = fakeHerdr();
  registerParent(input);
  const originalPath = process.env.PATH;
  const originalFail = process.env.HERDR_SEND_FAIL;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  process.env.HERDR_SEND_FAIL = "1";
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(input.event.id));
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).rejects.toThrow("Herdr exited with status 9");
    const calls = readFileSync(fake.log, "utf8");
    expect(
      S.getWorkflowEventEffectWithPrefix(
        input.run.id,
        input.event.id,
        "workflow.instruction:",
      )?.status,
    ).toBe("pending");
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(0);

    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).rejects.toThrow("has a pending receipt");
    expect(readFileSync(fake.log, "utf8")).toBe(calls);
    await expect(svc.workflowInstructions.dispatchPending()).resolves.toEqual(
      [],
    );
    expect(readFileSync(fake.log, "utf8")).toBe(calls);
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    if (originalFail === undefined) delete process.env.HERDR_SEND_FAIL;
    else process.env.HERDR_SEND_FAIL = originalFail;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

// A parent that registered an event subscription is woken by a ping and reads the run's state
// itself. Delivering an instruction as well would drive one run down two paths, so the subscription
// row — not a column on the run — decides which path it is on.
test("a run whose parent subscribed to it is not a delivery target", async () => {
  const input = fixture("subscribed-parent");
  const fake = fakeHerdr();
  registerParent(input);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(input.event.id));
  try {
    expect(
      S.workflowRunsWithPendingEvents().map((run) => run.id),
    ).toContainEqual(input.run.id);

    const subscription = svc.events.subscribe({
      repo: input.repo.full_name,
      target: "herdr-pane",
      session: "me-repo",
      pane: "w1:p1",
      resources: [
        `workflow_run:${input.run.id}`,
        `pull:${input.run.pr_number}`,
      ],
    });
    expect(
      S.workflowRunsWithPendingEvents().map((run) => run.id),
    ).not.toContainEqual(input.run.id);
    await expect(svc.workflowInstructions.dispatchPending()).resolves.toEqual(
      [],
    );
    expect(herdrCalls(fake.log)).toBe("");
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(0);
    expect(next).not.toHaveBeenCalled();

    // Releasing the subscription is the only thing that puts the run back on the delivery path.
    svc.events.unsubscribe({ subscription: subscription.id });
    expect(
      S.workflowRunsWithPendingEvents().map((run) => run.id),
    ).toContainEqual(input.run.id);
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("ended runs consume pending events without delivering progression", async () => {
  const input = fixture("terminal");
  // The run ends when its linked PR closes; nothing is written on the run row to say so.
  S.updateIssue(S.getIssue(input.repo.id, input.run.pr_number)!.id, {
    state: "closed",
  });
  const next = vi.spyOn(svc.workflowRuns, "next");
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: `Workflow run #${input.run.id} has ended: pull request #${input.run.pr_number} is closed or merged`,
    });
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(input.event.id);
    expect(next).not.toHaveBeenCalled();
  } finally {
    next.mockRestore();
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("delivery targets the registered parent pane, never one of the run's children", async () => {
  const input = fixture("parent-only");
  const fake = fakeHerdr();
  const execute = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const verify = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  S.appendWorkflowRunStepSession(input.run.id, "execute", execute);
  S.appendWorkflowRunStepSession(input.run.id, "verify", verify);
  for (const [launchId, paneId] of [
    [execute, "w1:p3"],
    [verify, "w1:p4"],
  ]) {
    S.registerHerdrPane({
      repoId: input.repo.id,
      launchId,
      paneId,
      sessionName: "me-repo",
      origin: "workflow",
    });
  }
  registerParent(input);
  // A human comment recorded while the Verify child is the run's most recent actor. Neither the
  // active step nor the session id on the wake moves the delivery target off the parent.
  const comment = S.emitEvent(input.repo.id, "pull_request.commented", "me", {
    number: input.run.pr_number,
    comment_id: 9001,
    author_type: "human",
    session_id: verify,
    source_payload_version: 1,
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  // A distinct reason per wake, so neither delivery is suppressed as a repeat of the previous
  // decision and both have to pick a pane of their own.
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockImplementation(async (_name, opts) => ({
      ...instructionResult(opts.event as number),
      reason: `wake ${opts.event}`,
    }));
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({ status: "delivered", pane_id: "w1:p1" });
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "delivered",
      event: comment.id,
      pane_id: "w1:p1",
    });

    const calls = readFileSync(fake.log, "utf8");
    expect(calls).not.toContain("w1:p3");
    expect(calls).not.toContain("w1:p4");
    expect(calls.match(/pane send-text/g)).toHaveLength(2);
    expect(calls.match(/pane send-keys/g)).toHaveLength(2);
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("a run with no recorded start fails visibly and keeps its cursor", async () => {
  const input = fixture("missing-start", { started: false });
  S.emitEvent(input.repo.id, "pull_request.commented", "me", {
    number: input.run.pr_number,
    comment_id: 9101,
    author_type: "human",
    source_payload_version: 1,
  });
  const next = vi.spyOn(svc.workflowRuns, "next");
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).rejects.toThrow("has no workflow_run.started event");
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(0);
    expect(next).not.toHaveBeenCalled();
  } finally {
    next.mockRestore();
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});
