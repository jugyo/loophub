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
  *"pane run"*)
    if [ "$HERDR_TEST_FAIL_RUN" = "1" ]; then exit 7; fi
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
  delete process.env.HERDR_TEST_FAIL_RUN;
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
  const oldSession = "22222222-2222-4222-8222-222222222222";
  const latestSession = "33333333-3333-4333-8333-333333333333";
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
    `pane run w1:p2 orchestrator: address review #9`,
  );
  expect(readFileSync(HERDR_LOG, "utf8")).not.toContain("agent list");
  expect(S.getAgentExecutionTarget(latestSession)).toMatchObject({
    provider: "herdr",
    target_id: "w1:p2",
    context: "test-session",
  });

  process.env.HERDR_TEST_FAIL_RUN = "1";
  await expect(
    svc.workflowRuns.deliver(
      repo.full_name,
      { run: started.run.id, text: "orchestrator: continue" },
      parent,
    ),
  ).rejects.toThrowError(/status 7/);

  delete process.env.HERDR_TEST_FAIL_RUN;
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
