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

function fixture(name: string) {
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
  const event = S.emitWorkflowEvent(repo.id, "workflow_run.started", "me", {
    id: run.id,
    workflow_id: workflow.id,
    issue_number: issue.number,
    pr_number: pr.number,
    session_id: parent,
  });
  return { repo, repoPath, run, event };
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
) {
  return svc.workflowInstructions.registerParentPane(input.repo.full_name, {
    run: input.run.id,
    launch_id: input.run.parent_session_id as string,
    session_name: "me-repo",
    pane_id: paneId,
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

test("parent readiness fails visibly until its pane registers during launch grace", async () => {
  const input = fixture("late-parent");
  const fake = fakeHerdr();
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(input.event.id));
  try {
    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
    ).rejects.toThrow(
      `Workflow instruction for event #${input.event.id} is pending but was not delivered`,
    );
    expect(S.getWorkflowRun(input.run.id)?.parent_ready_at).not.toBeNull();
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(0);
    expect(herdrCalls(fake.log)).toBe("");
    expect(next).not.toHaveBeenCalled();

    registerParentPane(input);
    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
    ).resolves.toMatchObject({
      instruction: {
        status: "delivered",
        event: input.event.id,
        pane_id: "w1:p1",
      },
    });
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

    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
    ).resolves.toMatchObject({
      run: input.run.id,
      instruction: {
        status: "delivered",
        event: input.event.id,
        pane_id: "w1:p1",
      },
    });
    expect(S.getWorkflowRun(input.run.id)?.parent_ready_confirmed).toBe(1);
    expect(herdrCalls(fake.log)).toContain("pane send-text w1:p1");
  } finally {
    next.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fake.bin, { recursive: true, force: true });
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("readiness keeps a pre-existing pending receipt visible after it completes", async () => {
  const input = fixture("premature-delivery");
  registerParentPane(input);
  const effect = "workflow.instruction:premature";
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const claimed = S.beginWorkflowEventEffect(
      input.run.id,
      input.event.id,
      effect,
    );
    expect(claimed?.acquired).toBe(true);

    // This is the race left by the old command, entirely within one DB timestamp tick: the worker
    // claimed before readiness, then completed after it, but all three rows carry the same time.
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    markParentReady(input);
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(
      S.completeWorkflowEventEffect(input.run.id, input.event.id, effect),
    ).not.toBeNull();
    S.advanceWorkflowRunEventCursor(input.run.id, input.event.id);
    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
    ).rejects.toThrow(
      `Workflow instruction for event #${input.event.id} was recorded before parent readiness; delivery cannot be confirmed`,
    );
    expect(S.getWorkflowRun(input.run.id)?.parent_ready_confirmed).toBe(0);
    expect(S.getWorkflowRun(input.run.id)?.parent_ready_at).not.toBeNull();

    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
    ).rejects.toThrow("delivery cannot be confirmed");
  } finally {
    vi.useRealTimers();
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});

test("readiness does not hide a pending receipt that already exists", async () => {
  const input = fixture("pending-before-ready");
  registerParentPane(input);
  const effect = "workflow.instruction:pending-before-ready";
  const claimed = S.beginWorkflowEventEffect(
    input.run.id,
    input.event.id,
    effect,
  );
  expect(claimed?.acquired).toBe(true);

  try {
    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
    ).rejects.toThrow("has a pending receipt");
    expect(S.getWorkflowRun(input.run.id)?.parent_ready_at).toBeNull();
    expect(S.getWorkflowRun(input.run.id)?.parent_ready_confirmed).toBe(0);

    expect(
      S.completeWorkflowEventEffect(input.run.id, input.event.id, effect),
    ).not.toBeNull();
    S.advanceWorkflowRunEventCursor(input.run.id, input.event.id);
    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
    ).rejects.toThrow("delivery cannot be confirmed");
    expect(S.getWorkflowRun(input.run.id)?.parent_ready_at).toBeNull();
  } finally {
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
    .mockReturnValue(Date.parse(input.run.created_at) + 5 * 60_000);
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

test("a repeated confirmed readiness signal keeps the first one", async () => {
  const input = fixture("repeated-ready");
  const fake = fakeHerdr();
  registerParentPane(input);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(input.event.id));
  try {
    const first = await svc.workflowInstructions.parentReady(
      input.repo.full_name,
      { run: input.run.id },
    );
    expect(first).toMatchObject({ run: input.run.id });
    const calls = herdrCalls(fake.log);
    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
    ).resolves.toMatchObject({
      ready_at: first.ready_at,
      instruction: { status: "idle" },
    });
    expect(herdrCalls(fake.log)).toBe(calls);
  } finally {
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
    .mockReturnValue(Date.parse(input.run.created_at) + 5 * 60_000);
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

test("an ambiguous send failure leaves a visible pending receipt and is not repeated", async () => {
  const input = fixture("send-failure");
  const fake = fakeHerdr();
  registerParentPane(input);
  const originalPath = process.env.PATH;
  const originalFail = process.env.HERDR_SEND_FAIL;
  process.env.PATH = `${fake.bin}:${originalPath}`;
  process.env.HERDR_SEND_FAIL = "1";
  const next = vi
    .spyOn(svc.workflowRuns, "next")
    .mockResolvedValue(instructionResult(input.event.id));
  try {
    await expect(
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
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
      svc.workflowInstructions.parentReady(input.repo.full_name, {
        run: input.run.id,
      }),
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

test("terminal runs consume pending events without delivering progression", async () => {
  const input = fixture("terminal");
  S.updateWorkflowRun(input.run.id, { status: "completed" });
  const next = vi.spyOn(svc.workflowRuns, "next");
  try {
    await expect(
      svc.workflowInstructions.dispatchRun(input.run.id),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "Workflow run is completed",
    });
    expect(S.getWorkflowRun(input.run.id)?.event_cursor).toBe(input.event.id);
    expect(next).not.toHaveBeenCalled();
  } finally {
    next.mockRestore();
    rmSync(input.repoPath, { recursive: true, force: true });
  }
});
