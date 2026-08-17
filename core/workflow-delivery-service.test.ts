import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-delivery-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-delivery-repo-"));
const BIN_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-delivery-bin-"));
const HERDR_LOG = join(HOME, "herdr.log");
const ORIGINAL_PATH = process.env.PATH;
const CLI = join(import.meta.dirname, "../cli/index.ts");
const TSX = createRequire(import.meta.url).resolve("tsx");

process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");
process.env.PATH = `${BIN_PATH}:${ORIGINAL_PATH ?? ""}`;
process.env.HERDR_TEST_LOG = HERDR_LOG;

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", REPO_PATH, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
}

function runCli(args: string[], parentSession: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      TSX,
      CLI,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPHUB_SESSION_ID: parentSession,
      },
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 0,
  };
}

beforeAll(async () => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(REPO_PATH, "README.md"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  const herdr = join(BIN_PATH, "herdr");
  writeFileSync(
    herdr,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
case "$*" in
  *"pane send-keys"*)
    if [ "$HERDR_TEST_FAIL_SUBMIT" = "1" ]; then exit 7; fi
    ;;
esac
`,
  );
  chmodSync(herdr, 0o755);

  svc = await import("./service.ts");
  S = await import("./store.ts");
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.HERDR_TEST_LOG;
  delete process.env.HERDR_TEST_FAIL_SUBMIT;
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
  rmSync(BIN_PATH, { recursive: true, force: true });
});

test("deliver activates the latest Execute session and sends one sanitized line to its pane", async () => {
  const repo = S.createRepo("me/workflow-delivery", REPO_PATH);
  const issue = S.createIssue(repo.id, "issue", "Deliver", "body", "me");
  const workflow = S.createWorkflow({
    name: "delivery",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "11111111-1111-4111-8111-111111111111";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const headSha = spawnSync(
    "git",
    ["-C", started.worktree, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).stdout.trim();
  const oldSession = "22222222-2222-4222-8222-222222222222";
  const latestSession = "33333333-3333-4333-8333-333333333333";
  const verifySession = "55555555-5555-4555-8555-555555555555";
  svc.workflowInstructions.registerParentPane(repo.full_name, {
    run: started.run.id,
    launch_id: parent,
    session_name: "test-session",
    pane_id: "w1:p0",
    launched_at: new Date().toISOString(),
  });
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: oldSession,
      agentName: `executor #${started.run.id}-1`,
      executionTarget: {
        provider: "herdr",
        targetId: "w1:p1",
        context: "test-session",
      },
      pointers: [],
    },
    parent,
  );
  const queued = await svc.workflowRuns.deliver(
    repo.full_name,
    {
      run: started.run.id,
      text: "orchestrator: address PR comment 19",
      target: "verifier",
    },
    parent,
  );
  expect(queued).toMatchObject({
    run: started.run.id,
    queued: true,
    target: "verifier",
    text: "orchestrator: address PR comment 19",
  });
  if (!("queued" in queued)) throw new Error("delivery was not queued");
  const queuedEvent = S.eventsForWorkflowRun(repo.id, started.run.id).findLast(
    (event) =>
      event.type === "workflow_run.delivery_queued" &&
      JSON.parse(event.payload).delivery_id === queued.delivery_id,
  );
  expect(queuedEvent).toBeDefined();
  expect(
    await svc.workflowRuns.next(repo.full_name, {
      run: started.run.id,
      event: queuedEvent!.id,
    }),
  ).toMatchObject({
    action: "launch_verify",
    delivery_id: queued.delivery_id,
  });
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      sessionId: verifySession,
      agentName: `verifier #${started.run.id}-2`,
      executionTarget: {
        provider: "herdr",
        targetId: "w1:p3",
        context: "test-session",
      },
      pointers: [],
      headSha,
    },
    parent,
  );
  const verifyLaunch = S.eventsForWorkflowRun(repo.id, started.run.id).findLast(
    (event) =>
      event.type === "workflow_step.launched" &&
      JSON.parse(event.payload).step === "verify",
  );
  expect(verifyLaunch).toBeDefined();
  const concurrentComment = svc.comments.createHumanForPull(
    repo.full_name,
    started.pr.number,
    "Please handle this new comment.",
  );
  const concurrentCommentEvent = S.eventsForPull(
    repo.id,
    started.pr.number,
    null,
  ).findLast(
    (event) =>
      event.type === "pull_request.commented" &&
      JSON.parse(event.payload).comment_id === concurrentComment.id,
  );
  expect(concurrentCommentEvent).toBeDefined();
  expect(
    await svc.workflowRuns.next(repo.full_name, {
      run: started.run.id,
      event: concurrentCommentEvent!.id,
    }),
  ).toMatchObject({
    action: "deliver",
    delivery_reason: "pr_comment",
    comment_id: concurrentComment.id,
    targets: ["executor"],
  });
  expect(
    await svc.workflowRuns.next(repo.full_name, {
      run: started.run.id,
      event: verifyLaunch!.id,
    }),
  ).toMatchObject({
    action: "deliver_pending",
    delivery_id: queued.delivery_id,
    target: "verifier",
  });
  await expect(
    svc.workflowRuns.deliver(
      repo.full_name,
      {
        run: started.run.id,
        text: queued.text,
        target: queued.target,
        deliveryId: queued.delivery_id,
      },
      parent,
    ),
  ).resolves.toMatchObject({
    agent_name: `verifier #${started.run.id}-2`,
    session_id: verifySession,
  });
  expect(
    S.eventsForWorkflowRun(repo.id, started.run.id).filter(
      (event) => event.type === "workflow_run.delivery_completed",
    ),
  ).toHaveLength(1);
  await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    { event: "PASS", body: "Verification complete." },
    verifySession,
  );
  const humanReviewer = "77777777-7777-4777-8777-777777777777";
  S.registerAgentSession(humanReviewer, "me", humanReviewer, "human");
  const feedbackReview = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    { event: "FEEDBACK", body: "@verifier please inspect this feedback." },
    humanReviewer,
  );
  const feedbackReviewEvent = S.eventsForPull(
    repo.id,
    started.pr.number,
    null,
  ).findLast(
    (event) =>
      event.type === "pull_request.review_submitted" &&
      JSON.parse(event.payload).review_id === feedbackReview.id,
  );
  expect(feedbackReviewEvent).toBeDefined();
  expect(
    await svc.workflowRuns.next(repo.full_name, {
      run: started.run.id,
      event: feedbackReviewEvent!.id,
    }),
  ).toMatchObject({
    action: "deliver",
    delivery_reason: "out_of_band_review",
    review_id: feedbackReview.id,
    targets: ["verifier"],
  });
  const queuedAfterReview = await svc.workflowRuns.deliver(
    repo.full_name,
    {
      run: started.run.id,
      text: `orchestrator: address review ${feedbackReview.id}`,
      target: "verifier",
    },
    parent,
  );
  expect(queuedAfterReview).toMatchObject({
    queued: true,
    target: "verifier",
  });
  if (!("queued" in queuedAfterReview)) {
    throw new Error("post-review delivery was not queued");
  }
  expect(readFileSync(HERDR_LOG, "utf8")).not.toContain(
    `orchestrator: address review ${feedbackReview.id}`,
  );
  const queuedAfterReviewEvent = S.eventsForWorkflowRun(
    repo.id,
    started.run.id,
  ).findLast(
    (event) =>
      event.type === "workflow_run.delivery_queued" &&
      JSON.parse(event.payload).delivery_id === queuedAfterReview.delivery_id,
  );
  expect(queuedAfterReviewEvent).toBeDefined();
  expect(
    await svc.workflowRuns.next(repo.full_name, {
      run: started.run.id,
      event: queuedAfterReviewEvent!.id,
    }),
  ).toMatchObject({
    action: "launch_verify",
    delivery_id: queuedAfterReview.delivery_id,
  });
  const freshLaunch = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      deliveryId: queuedAfterReview.delivery_id,
    },
    parent,
  );
  const freshVerifySession = freshLaunch.session_id;
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      sessionId: freshVerifySession,
      agentName: freshLaunch.agent_name,
      executionTarget: {
        provider: "herdr",
        targetId: "w1:p5",
        context: "test-session",
      },
      pointers: freshLaunch.pointers,
      headSha: freshLaunch.head_sha,
    },
    parent,
  );
  const freshVerifyLaunch = S.eventsForWorkflowRun(
    repo.id,
    started.run.id,
  ).findLast(
    (event) =>
      event.type === "workflow_step.launched" &&
      JSON.parse(event.payload).session_id === freshVerifySession,
  );
  expect(freshVerifyLaunch).toBeDefined();
  expect(
    await svc.workflowRuns.next(repo.full_name, {
      run: started.run.id,
      event: freshVerifyLaunch!.id,
    }),
  ).toMatchObject({
    action: "deliver_pending",
    delivery_id: queuedAfterReview.delivery_id,
    target: "verifier",
  });
  await expect(
    svc.workflowRuns.deliver(
      repo.full_name,
      {
        run: started.run.id,
        text: queuedAfterReview.text,
        target: queuedAfterReview.target,
        deliveryId: queuedAfterReview.delivery_id,
      },
      parent,
    ),
  ).resolves.toMatchObject({
    agent_name: freshLaunch.agent_name,
    pane_id: "w1:p5",
    session_id: freshVerifySession,
  });
  expect(readFileSync(HERDR_LOG, "utf8")).toContain(
    `pane send-text w1:p5 \u001b[200~orchestrator: address review ${feedbackReview.id}\u001b[201~`,
  );
  const completedAfterReviewEvent = S.eventsForWorkflowRun(
    repo.id,
    started.run.id,
  ).findLast(
    (event) =>
      event.type === "workflow_run.delivery_completed" &&
      JSON.parse(event.payload).delivery_id === queuedAfterReview.delivery_id,
  );
  expect(completedAfterReviewEvent).toBeDefined();
  expect(
    await svc.workflowRuns.next(repo.full_name, {
      run: started.run.id,
      event: completedAfterReviewEvent!.id,
    }),
  ).toMatchObject({
    action: "wait",
    reason: "Queued comment instruction delivery is complete.",
  });
  await expect(
    svc.workflowRuns.deliver(
      repo.full_name,
      {
        run: started.run.id,
        text: "orchestrator: verify the comment",
        target: "verifier",
      },
      parent,
    ),
  ).resolves.toMatchObject({
    agent_name: freshLaunch.agent_name,
    pane_id: "w1:p5",
    session_id: freshVerifySession,
  });
  const verifierCliResult = runCli(
    [
      "workflow",
      "deliver",
      "--repo",
      repo.full_name,
      "--run",
      String(started.run.id),
      "--target",
      "verifier",
      "--text",
      "orchestrator: verify the comment",
    ],
    parent,
  );
  expect(verifierCliResult.exitCode, verifierCliResult.stderr).toBe(0);
  expect(verifierCliResult.stdout).toContain(
    `delivered instruction to ${freshLaunch.agent_name}`,
  );
  expect(verifierCliResult.stdout).toContain("pane\tw1:p5");
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: latestSession,
      agentName: `executor #${started.run.id}-2`,
      executionTarget: {
        provider: "herdr",
        targetId: "w1:p2",
        context: "test-session",
      },
      pointers: [],
    },
    parent,
  );
  const delivered = await svc.workflowRuns.deliver(
    repo.full_name,
    {
      run: started.run.id,
      text: " orchestrator:\taddress\nreview\u0007  #9 ",
    },
    parent,
  );

  expect(delivered).toEqual({
    run: started.run.id,
    agent_name: `executor #${started.run.id}-2`,
    pane_id: "w1:p2",
    session_id: latestSession,
    text: "orchestrator: address review #9",
  });
  expect(S.getWorkflowRun(started.run.id)).toMatchObject({
    active_step: "execute",
    active_session_id: latestSession,
  });
  expect(readFileSync(HERDR_LOG, "utf8")).toContain(
    `pane send-text w1:p2 \u001b[200~orchestrator: address review #9\u001b[201~`,
  );
  expect(readFileSync(HERDR_LOG, "utf8")).toContain(
    "pane send-keys w1:p2 Enter",
  );
  expect(readFileSync(HERDR_LOG, "utf8")).not.toContain("agent list");
  expect(S.getAgentExecutionTarget(latestSession)).toMatchObject({
    provider: "herdr",
    target_id: "w1:p2",
    context: "test-session",
  });
  await expect(
    svc.workflowRuns.deliver(
      repo.full_name,
      {
        run: started.run.id,
        text: "orchestrator: verify after executor delivery",
        target: "verifier",
      },
      parent,
    ),
  ).resolves.toMatchObject({
    agent_name: freshLaunch.agent_name,
    pane_id: "w1:p5",
    session_id: freshVerifySession,
  });

  await expect(
    svc.workflowRuns.deliver(
      repo.full_name,
      {
        run: started.run.id,
        text: "orchestrator: coordinate the comment",
        target: "orchestrator",
      },
      parent,
    ),
  ).resolves.toMatchObject({ pane_id: "w1:p0", session_id: parent });
  expect(S.getWorkflowRun(started.run.id)).toMatchObject({
    active_step: "execute",
    active_session_id: latestSession,
  });
  expect(readFileSync(HERDR_LOG, "utf8")).toContain("pane send-text w1:p5");
  expect(readFileSync(HERDR_LOG, "utf8")).toContain("pane send-text w1:p0");
  await expect(
    svc.workflowRuns.deliver(
      repo.full_name,
      { run: started.run.id, text: "invalid", target: "reviewer" },
      parent,
    ),
  ).rejects.toThrowError(/delivery target must be one of/);

  process.env.HERDR_TEST_FAIL_SUBMIT = "1";
  await expect(
    svc.workflowRuns.deliver(
      repo.full_name,
      { run: started.run.id, text: "orchestrator: continue" },
      parent,
    ),
  ).rejects.toThrowError(/status 7/);

  delete process.env.HERDR_TEST_FAIL_SUBMIT;
  const cliResult = runCli(
    [
      "workflow",
      "deliver",
      "--repo",
      repo.full_name,
      "--run",
      String(started.run.id),
      "--text",
      "orchestrator: continue",
    ],
    parent,
  );
  expect(cliResult.exitCode, cliResult.stderr).toBe(0);
  expect(cliResult.stdout).toContain(
    `delivered instruction to executor #${started.run.id}-2`,
  );
  expect(cliResult.stdout).toContain("pane\tw1:p2");
  const unaddressedSession = "44444444-4444-4444-8444-444444444444";
  S.registerAgentSession(
    unaddressedSession,
    "workflow-step",
    unaddressedSession,
    `executor #${started.run.id}-3`,
    "codex",
    "workflow-step",
  );
  S.appendWorkflowRunStepSession(started.run.id, "execute", unaddressedSession);
  const failedCliResult = runCli(
    [
      "workflow",
      "deliver",
      "--repo",
      repo.full_name,
      "--run",
      String(started.run.id),
      "--text",
      "orchestrator: continue",
    ],
    parent,
  );
  expect(failedCliResult.exitCode).toBe(1);
  expect(failedCliResult.stderr).toContain("has no execution target");
}, 20_000);
