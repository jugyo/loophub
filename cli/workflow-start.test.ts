import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REQUIRE = createRequire(import.meta.url);
const TSX = REQUIRE.resolve("tsx");
const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-start-home-"));
const REPO_PATH = realpathSync(
  mkdtempSync(join(tmpdir(), "lh-workflow-start-repo-")),
);
const REPO = "me/workflow-start";
const OTHER_REPO_PATH = realpathSync(
  mkdtempSync(join(tmpdir(), "lh-workflow-start-other-repo-")),
);
const OTHER_REPO = "other/workflow-start";
const UNRELATED_HERDR_FOCUS = {
  workspace_id: "w9",
  tab_id: "w9:t8",
  pane_id: "w9:p7",
};
const {
  LOOPHUB_SESSION_ID: _sessionId,
  LOOPHUB_WORKFLOW_REPO: _workflowRepo,
  LOOPHUB_WORKFLOW_RUN: _workflowRun,
  LOOPHUB_WORKFLOW_STEP: _workflowStep,
  ...BASE_ENV
} = process.env;

function run(args: string[], env: Record<string, string> = {}, cwd?: string) {
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
      cwd,
      encoding: "utf8",
      env: {
        ...BASE_ENV,
        LOOPHUB_HOME: HOME,
        LOOPHUB_DB: join(HOME, "loophub.db"),
        ...env,
      },
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 0,
  };
}

function git(args: string[], path = REPO_PATH): void {
  const result = spawnSync("git", ["-C", path, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
}

// A fake `herdr` that logs every invocation and emits configurable JSON on stdout for the
// worktree-open / tab-create calls the launch orchestration makes, so a test can drive the
// worktree open→reuse dance the same way `lh build --herdr` does. `sendTextExit` fails only the
// call that types the launch command into the pane, leaving the earlier open/create succeeding —
// the shape a real failed parent launch takes after its workspace was already created.
//
// Neither `pane send-text` nor `pane split` moves herdr's focus (verified against the real CLI:
// `pane split` focuses only with an explicit `--focus`), so neither changes the focused state here.
function fakeRuntime(
  opts: {
    sendTextExit?: number;
    focusedState?: Record<string, string>;
    paneCloseExit?: number;
    paneListJson?: string;
    worktreeOpenJson?: string;
    tabCreateJson?: string;
    paneSplitJson?: string;
  } = {},
) {
  const {
    sendTextExit = 0,
    focusedState,
    paneCloseExit = 0,
    paneListJson = "",
    worktreeOpenJson = "",
    tabCreateJson = REUSE_TAB_JSON,
    paneSplitJson = '{"result":{"pane":{"pane_id":"w1:p4"}}}',
  } = opts;
  const dir = mkdtempSync(join(tmpdir(), "lh-workflow-runtime-"));
  const log = join(dir, "herdr.log");
  const focusedStatePath = join(dir, "focused-state.json");
  const herdr = join(dir, "herdr");
  const claude = join(dir, "claude");
  const codex = join(dir, "codex");
  const grok = join(dir, "grok");
  const cursor = join(dir, "cursor-agent");
  if (focusedState) {
    writeFileSync(focusedStatePath, JSON.stringify(focusedState));
  }
  writeFileSync(
    herdr,
    `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$HERDR_LOG"
if [ "$1" = "--session" ]; then shift 2; fi
command="$*"
change_focus() {
  if [ -n "$HERDR_FOCUSED_STATE" ]; then
    printf '%s' '{"workspace_id":"changed","tab_id":"changed","pane_id":"changed"}' > "$HERDR_FOCUSED_STATE"
  fi
}
change_focus_without_no_focus() {
  case " $command " in
    *" --no-focus "*) ;;
    *) change_focus ;;
  esac
}
change_focus_if_closing() {
  pattern=$(printf '"%s":"%s"' "$1" "$2")
  if [ -n "$HERDR_FOCUSED_STATE" ] && grep -Fq "$pattern" "$HERDR_FOCUSED_STATE"; then
    change_focus
  fi
}
case " $command " in
  *" worktree open "*) change_focus_without_no_focus; printf '%s' '${worktreeOpenJson}'; exit 0 ;;
  *" pane list "*) printf '%s' '${paneListJson}'; exit 0 ;;
  *" pane split "*) printf '%s' '${paneSplitJson}'; exit 0 ;;
  *" pane zoom "*) change_focus; exit 0 ;;
  *" pane move "*) change_focus_without_no_focus; exit 0 ;;
  *" pane close "*) change_focus_if_closing pane_id "$3"; exit ${paneCloseExit} ;;
  *" tab close "*) change_focus_if_closing tab_id "$3"; exit 0 ;;
  *" tab create "*) change_focus_without_no_focus; printf '%s' '${tabCreateJson}'; exit 0 ;;
  *" pane send-text "*) exit ${sendTextExit} ;;
  *" workspace focus "*|*" tab focus "*|*" agent focus "*|*" pane focus "*) change_focus; exit 0 ;;
esac
exit 0
`,
  );
  writeFileSync(
    claude,
    '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 0\n',
  );
  writeFileSync(codex, '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 0\n');
  writeFileSync(grok, '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 0\n');
  writeFileSync(
    cursor,
    '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 0\n',
  );
  chmodSync(herdr, 0o755);
  chmodSync(claude, 0o755);
  chmodSync(codex, 0o755);
  chmodSync(grok, 0o755);
  chmodSync(cursor, 0o755);
  return { dir, focusedStatePath, log };
}

function expectUnrelatedHerdrFocus(runtime: {
  focusedStatePath: string;
}): void {
  expect(JSON.parse(readFileSync(runtime.focusedStatePath, "utf8"))).toEqual(
    UNRELATED_HERDR_FOCUS,
  );
}

// A fakeRuntime with no `claude` binary, so a test asserts a Codex launch never requires claude.
function codexOnlyRuntime() {
  const runtime = fakeRuntime();
  rmSync(join(runtime.dir, "claude"), { force: true });
  return runtime;
}

// A fakeRuntime with no `claude` binary, so a test asserts a Grok launch never requires claude.
function grokOnlyRuntime() {
  const runtime = fakeRuntime();
  rmSync(join(runtime.dir, "claude"), { force: true });
  return runtime;
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(HOME, "config.json"), JSON.stringify(config));
}

function clearConfig(): void {
  rmSync(join(HOME, "config.json"), { force: true });
}

// A first-time `herdr worktree open` response: a brand-new single-tab workspace whose tab/root-pane
// come straight from the open, so the launch starts the agent with `--tab` in that workspace.
const FRESH_OPEN_JSON = JSON.stringify({
  result: {
    already_open: false,
    workspace: { workspace_id: "w1" },
    tab: { tab_id: "w1:t1" },
    root_pane: { pane_id: "w1:p1" },
  },
});
// An `already_open` open response — the launch then creates a genuinely new tab inside the reused
// workspace (herdrTabCreateInWorkspaceArgv) rather than splitting its existing pane.
const REUSE_OPEN_JSON = JSON.stringify({
  result: { already_open: true, workspace: { workspace_id: "w1" } },
});
const REUSE_TAB_JSON = JSON.stringify({
  result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } },
});

beforeAll(() => {
  for (const path of [REPO_PATH, OTHER_REPO_PATH]) {
    git(["init", "-q", "-b", "main"], path);
    git(["config", "user.email", "t@example.local"], path);
    git(["config", "user.name", "tester"], path);
    writeFileSync(join(path, "README.md"), "hello\n");
    git(["add", "-A"], path);
    git(["commit", "-qm", "init"], path);
  }
  for (const [path, name] of [
    [REPO_PATH, REPO],
    [OTHER_REPO_PATH, OTHER_REPO],
  ]) {
    const added = run(["repo", "add", path, "--name", name]);
    if (added.exitCode !== 0) throw new Error(added.stderr);
  }
  const workflow = run([
    "workflow",
    "create",
    "standard",
    "--description",
    "test",
  ]);
  if (workflow.exitCode !== 0) throw new Error(workflow.stderr);
});

test("workflow turn done resolves explicit, launched, and cwd repo contexts", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Workflow turn-done task",
    "--body",
    "Execute the task",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const started = run([
    "workflow",
    "start",
    issue,
    "--repo",
    REPO,
    "--workflow",
    "standard",
    "--no-launch",
    "--json",
  ]);
  expect(started.exitCode, started.stderr).toBe(0);
  const runResult = JSON.parse(started.stdout);
  const parentSession = runResult.session_id;
  // The parent session is allowed to declare turn done (stepActorAllowed treats it as the run
  // owner), so it exercises the CLI plumbing without spawning a real Execute child.
  const sessionEnv = { LOOPHUB_SESSION_ID: parentSession };

  // Worktree cwd alone is enough: resolveRepo infers the registered owner/name (#1595).
  const fromWorktree = run(
    ["workflow", "turn", "done"],
    {
      ...sessionEnv,
      LOOPHUB_WORKFLOW_RUN: String(runResult.run.id),
    },
    runResult.worktree,
  );
  expect(fromWorktree.exitCode, fromWorktree.stderr).toBe(0);
  expect(fromWorktree.stdout).toContain(
    `declared turn done for Workflow run #${runResult.run.id}`,
  );

  // Outside any registered root/worktree, repo context is still required.
  const missingRepoContext = run(
    ["workflow", "turn", "done"],
    {
      ...sessionEnv,
      LOOPHUB_WORKFLOW_RUN: String(runResult.run.id),
    },
    HOME,
  );
  expect(missingRepoContext.exitCode).not.toBe(0);
  expect(missingRepoContext.stderr).toContain("Cannot determine the repo");

  // A wrong repo context resolves a repo, but the run does not belong to it.
  const wrongRepoContext = run(
    ["workflow", "turn", "done"],
    {
      ...sessionEnv,
      LOOPHUB_WORKFLOW_REPO: OTHER_REPO,
      LOOPHUB_WORKFLOW_RUN: String(runResult.run.id),
    },
    runResult.worktree,
  );
  expect(wrongRepoContext.exitCode).not.toBe(0);
  expect(wrongRepoContext.stderr).toContain(
    "error 404: Workflow run not found for repo",
  );

  // The launched-session env context (LOOPHUB_WORKFLOW_REPO/RUN) resolves the target.
  const launched = run(
    ["workflow", "turn", "done"],
    {
      ...sessionEnv,
      LOOPHUB_WORKFLOW_REPO: REPO,
      LOOPHUB_WORKFLOW_RUN: String(runResult.run.id),
    },
    runResult.worktree,
  );
  expect(launched.exitCode, launched.stderr).toBe(0);
  expect(launched.stdout).toContain(
    `declared turn done for Workflow run #${runResult.run.id}`,
  );

  // Explicit flags win over a misleading env context.
  const explicit = run(
    [
      "workflow",
      "turn",
      "done",
      "--repo",
      REPO,
      "--run",
      String(runResult.run.id),
    ],
    {
      ...sessionEnv,
      LOOPHUB_WORKFLOW_REPO: OTHER_REPO,
      LOOPHUB_WORKFLOW_RUN: "999999",
    },
  );
  expect(explicit.exitCode, explicit.stderr).toBe(0);

  // cwd repo resolution when only the run id is supplied.
  const cwd = run(
    ["workflow", "turn", "done"],
    {
      ...sessionEnv,
      LOOPHUB_WORKFLOW_RUN: String(runResult.run.id),
    },
    REPO_PATH,
  );
  expect(cwd.exitCode, cwd.stderr).toBe(0);

  const escalated = run(
    [
      "workflow",
      "escalate",
      "--repo",
      REPO,
      "--run",
      String(runResult.run.id),
      "--reason",
      "See issue comment",
    ],
    sessionEnv,
  );
  expect(escalated.exitCode, escalated.stderr).toBe(0);
  expect(escalated.stdout).toContain(
    `declared escalation for Workflow run #${runResult.run.id}`,
  );

  const humanEscalation = run(
    [
      "workflow",
      "escalate-human",
      "--repo",
      REPO,
      "--run",
      String(runResult.run.id),
      "--reason",
      "Rework limit reached",
    ],
    { LOOPHUB_SESSION_ID: parentSession },
  );
  expect(humanEscalation.exitCode, humanEscalation.stderr).toBe(0);
  expect(humanEscalation.stdout).toContain("issue comment\tcompleted");
  expect(humanEscalation.stdout).not.toContain("inbox");

  const replay = run(
    [
      "workflow",
      "escalate-human",
      "--repo",
      REPO,
      "--run",
      String(runResult.run.id),
      "--reason",
      "Rework limit reached",
    ],
    { LOOPHUB_SESSION_ID: parentSession },
  );
  expect(replay.exitCode, replay.stderr).toBe(0);
  expect(replay.stdout).toContain("issue comment\talready completed");
  expect(replay.stdout).not.toContain("inbox");

  const issueView = run(["issue", "view", issue, "--repo", REPO, "--json"]);
  expect(JSON.parse(issueView.stdout).comment_list).toHaveLength(1);

  const { DatabaseSync } = REQUIRE(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  const db = new DatabaseSync(join(HOME, "loophub.db"));
  db.exec(`
    CREATE TRIGGER fail_escalation_comment
    BEFORE INSERT ON comments
    BEGIN
      SELECT RAISE(FAIL, 'comments unavailable');
    END
  `);
  const failed = run(
    [
      "workflow",
      "escalate-human",
      "--repo",
      REPO,
      "--run",
      String(runResult.run.id),
      "--reason",
      "Comment failure must be visible",
    ],
    { LOOPHUB_SESSION_ID: parentSession },
  );
  db.exec("DROP TRIGGER fail_escalation_comment");
  db.close();
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stdout).toContain("issue comment\tfailed");
  expect(failed.stdout).toContain("issue comment error\tcomments unavailable");

  const failedReplay = run(
    [
      "workflow",
      "escalate-human",
      "--repo",
      REPO,
      "--run",
      String(runResult.run.id),
      "--reason",
      "Comment failure must be visible",
    ],
    { LOOPHUB_SESSION_ID: parentSession },
  );
  expect(failedReplay.exitCode).not.toBe(0);
  expect(failedReplay.stdout).toContain("issue comment\tpending");
  const issueAfterFailure = run([
    "issue",
    "view",
    issue,
    "--repo",
    REPO,
    "--json",
  ]);
  expect(JSON.parse(issueAfterFailure.stdout).comment_list).toHaveLength(1);
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
  rmSync(OTHER_REPO_PATH, { recursive: true, force: true });
});

test("workflow start rejects conflicting positional and --repo values before DB access", () => {
  const result = run([
    "workflow",
    "start",
    `${REPO}/999999`,
    "--repo",
    "other/repo",
    "--workflow",
    "standard",
    "--no-launch",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    `conflicting repo: positional '${REPO}' vs --repo 'other/repo'`,
  );
});

test("workflow start --no-launch creates a run and skips herdr launch", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Workflow task",
    "--body",
    "Do it",
  ]);
  expect(issueOut.exitCode).toBe(0);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);

  const started = run([
    "workflow",
    "start",
    issue,
    "--repo",
    REPO,
    "--workflow",
    "standard",
    "--no-launch",
    "--json",
  ]);

  expect(started.exitCode, started.stderr).toBe(0);
  const body = JSON.parse(started.stdout);
  expect(body.run).toMatchObject({
    status: "running",
    current_step: "execute",
    rework_count: 0,
  });
  expect(body.workflow.name).toBe("standard");
  expect(body.issue.number).toBe(Number(issue));
  expect(body.pr.number).toBeGreaterThan(Number(issue));
  expect(existsSync(body.worktree)).toBe(true);
  expect(existsSync(body.lock_path)).toBe(true);
  expect(body.parent.user_prompt).not.toMatch(/^\/lh-/m);

  const instructionJson = run([
    "workflow",
    "instruction",
    String(body.run.id),
    "--repo",
    REPO,
    "--note",
    "start on the first acceptance criterion",
    "--json",
  ]);
  expect(instructionJson.exitCode, instructionJson.stderr).toBe(0);
  expect(JSON.parse(instructionJson.stdout)).toMatchObject({
    action: "deliver",
    delivery_reason: "human_instruction",
  });

  const instructionText = run([
    "workflow",
    "instruction",
    String(body.run.id),
    "--repo",
    REPO,
    "--note",
    "start on the first acceptance criterion",
  ]);
  expect(instructionText.exitCode, instructionText.stderr).toBe(0);
  expect(instructionText.stdout.trim().split("\n")).toEqual([
    "deliver",
    "A human supplied additional work for Execute.",
  ]);
});

test("workflow launch-step rebuilds only its parent tab as a staged grid", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Grid child panes",
    "--body",
    "Keep Workflow panes balanced",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const started = run([
    "workflow",
    "start",
    issue,
    "--repo",
    REPO,
    "--workflow",
    "standard",
    "--no-launch",
    "--json",
  ]);
  expect(started.exitCode, started.stderr).toBe(0);
  const body = JSON.parse(started.stdout);
  const paneListJson = JSON.stringify({
    result: {
      panes: [
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          agent: "claude",
          label: `orchestrator #${body.run.id}`,
        },
        {
          pane_id: "w1:p3",
          tab_id: "w1:t1",
          workspace_id: "w1",
          agent: "claude",
          label: `executor #${body.run.id}-1`,
        },
        {
          pane_id: "w1:p4",
          tab_id: "w1:t2",
          workspace_id: "w1",
          agent: "claude",
          label: "unrelated",
        },
      ],
    },
  });
  const runtime = fakeRuntime({
    focusedState: UNRELATED_HERDR_FOCUS,
    paneListJson,
    tabCreateJson: JSON.stringify({
      result: {
        tab: { tab_id: "w1:t3" },
        root_pane: { pane_id: "w1:p10" },
      },
    }),
    // The child's pane, split off the parent's — the pane the layout below then arranges.
    paneSplitJson: JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }),
  });
  try {
    const launched = run(
      [
        "workflow",
        "launch-step",
        "--repo",
        REPO,
        "--run",
        String(body.run.id),
        "--step",
        "execute",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_FOCUSED_STATE: runtime.focusedStatePath,
        HERDR_LOG: runtime.log,
        HERDR_TAB_ID: "w1:t1",
        HERDR_PANE_ID: "w1:p2",
        LOOPHUB_SESSION_ID: body.session_id,
      },
    );

    expect(launched.exitCode, launched.stderr).toBe(0);
    expect(launched.stdout).toContain(`agent\texecutor #${body.run.id}-1`);
    const log = readFileSync(runtime.log, "utf8");
    // The child splits its parent's pane, so it lands in the run's own tab.
    expect(log).toMatch(/pane split w1:p2 --direction down --cwd /);
    expect(log).toContain(`pane rename w1:p3 executor #${body.run.id}-1`);
    expect(log).toMatch(/pane send-text w1:p3 .*claude /);
    expect(log).toContain("pane list");
    expect(log).toContain("tab create --workspace w1 --no-focus");
    expect(log).toContain(
      "pane move w1:p3 --tab w1:t3 --split down --target-pane w1:p10 --ratio 0.5 --no-focus",
    );
    expect(log).toContain(
      "pane move w1:p3 --tab w1:t1 --split right --target-pane w1:p2 --ratio 0.5 --no-focus",
    );
    expect(log).toContain("tab close w1:t3");
    expect(log).not.toContain("pane move w1:p4");
    expect(log).not.toContain("pane zoom");
    expect(log).not.toMatch(/(?:workspace|tab|agent) focus/);
    expectUnrelatedHerdrFocus(runtime);

    // The layout is step-agnostic, and the run now owns a live Execute child, so the launch that
    // exercises the missing-tab-id fallback is a Verify one (#2150).
    const legacyLaunch = run(
      [
        "workflow",
        "launch-step",
        "--repo",
        REPO,
        "--run",
        String(body.run.id),
        "--step",
        "verify",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_FOCUSED_STATE: runtime.focusedStatePath,
        HERDR_LOG: runtime.log,
        HERDR_PANE_ID: "",
        HERDR_PANE_TAB_ID: "",
        HERDR_TAB: "",
        HERDR_TAB_ID: "",
        LOOPHUB_SESSION_ID: body.session_id,
      },
    );
    expect(legacyLaunch.exitCode, legacyLaunch.stderr).toBe(0);
    expect(legacyLaunch.stderr).toContain(
      "warning: skipped Workflow pane layout because no parent Herdr tab id was available",
    );
    const relaunchedLog = readFileSync(runtime.log, "utf8").slice(log.length);
    // With no parent pane to split, the child falls back to its own fresh tab.
    expect(relaunchedLog).toMatch(/tab create --cwd /);
    expect(relaunchedLog).toMatch(/pane send-text w1:p10 /);
    expect(relaunchedLog).not.toMatch(/(?:workspace|tab|agent) focus/);
    expectUnrelatedHerdrFocus(runtime);
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("fresh Verify closes the previous Verify pane before launching after rework", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Fresh Verify lifecycle",
    "--body",
    "Close the previous Verify pane before re-verification",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const started = run([
    "workflow",
    "start",
    issue,
    "--repo",
    REPO,
    "--workflow",
    "standard",
    "--no-launch",
    "--json",
  ]);
  expect(started.exitCode, started.stderr).toBe(0);
  const body = JSON.parse(started.stdout);
  const parentEnv = { LOOPHUB_SESSION_ID: body.session_id };
  const fixturePath = join(body.worktree, "verify-lifecycle.txt");
  const commitWorktree = (message: string) => {
    const added = spawnSync("git", ["-C", body.worktree, "add", "."], {
      encoding: "utf8",
    });
    expect(added.status, added.stderr).toBe(0);
    const committed = spawnSync(
      "git",
      ["-C", body.worktree, "commit", "-m", message],
      { encoding: "utf8" },
    );
    expect(committed.status, committed.stderr).toBe(0);
  };
  const headSha = () =>
    spawnSync("git", ["-C", body.worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
  // Post the domain fact a Verify child would produce: a PR review authored by the
  // run's verifier child, pinned to the reviewed head. A dedicated registered session gives the
  // review the exact `verifier #<run>-<seq>` author the run reads its verdict from.
  const postWorkflowReview = (
    seq: number,
    event: "pass" | "request_changes",
    sha: string,
  ) => {
    const sid = `verifier-sess-${body.run.id}-${seq}`;
    const registered = run([
      "session",
      "register",
      "--id",
      sid,
      "--agent",
      "workflow-step",
      "--session",
      sid,
      "--name",
      `verifier #${body.run.id}-${seq}`,
    ]);
    expect(registered.exitCode, registered.stderr).toBe(0);
    return run(
      [
        "pr",
        "review",
        String(body.pr.number),
        "--repo",
        REPO,
        "--commit",
        sha,
        "--event",
        event,
        "--body",
        `Verify ${event}`,
      ],
      { LOOPHUB_SESSION_ID: sid },
    );
  };
  const transition = (action: "advance-to-verify" | "request-rework") =>
    run(
      ["workflow", "run", action, "--repo", REPO, "--run", String(body.run.id)],
      parentEnv,
    );
  const launch = (
    step: "execute" | "verify",
    runtimeDir: string,
    log: string,
  ) =>
    run(
      [
        "workflow",
        "launch-step",
        "--repo",
        REPO,
        "--run",
        String(body.run.id),
        "--step",
        step,
      ],
      {
        ...parentEnv,
        HERDR_FOCUSED_STATE: join(runtimeDir, "focused-state.json"),
        PATH: `${runtimeDir}:${process.env.PATH}`,
        HERDR_LOG: log,
        HERDR_TAB_ID: "",
        HERDR_TAB: "",
        HERDR_PANE_TAB_ID: "",
        // Blank so this test's children fall back to their own tab. Left unset, the *test runner's*
        // own herdr pane would leak in and every child would split it.
        HERDR_PANE_ID: "",
      },
    );

  const firstRuntime = fakeRuntime({
    focusedState: UNRELATED_HERDR_FOCUS,
    // Every child launched through this runtime lands in pane w1:p3 — the pane the recorded
    // execution target points at, and so the one a later Verify closes.
    tabCreateJson: JSON.stringify({
      result: { tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p3" } },
    }),
    paneListJson: JSON.stringify({ result: { panes: [] } }),
  });
  const freshRuntime = fakeRuntime({
    focusedState: UNRELATED_HERDR_FOCUS,
    // The child's pane now comes from the tab this launch creates, not from `agent start`.
    tabCreateJson: JSON.stringify({
      result: { tab: { tab_id: "w1:t5" }, root_pane: { pane_id: "w1:p5" } },
    }),
    paneListJson: JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p1",
            agent: "claude",
            label: `orchestrator #${body.run.id}`,
          },
          {
            pane_id: "w1:p2",
            agent: "claude",
            label: `executor #${body.run.id}-2`,
          },
          {
            pane_id: "w1:p3",
            agent: "claude",
            label: `verifier #${body.run.id}-1`,
          },
          {
            pane_id: "w1:p4",
            agent: "claude",
            label: `verifier #${body.run.id + 1}-9`,
          },
        ],
      },
    }),
  });
  const closeFailureRuntime = fakeRuntime({
    focusedState: UNRELATED_HERDR_FOCUS,
    paneCloseExit: 42,
    paneListJson: JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p5",
            agent: "claude",
            label: `verifier #${body.run.id}-3`,
          },
          {
            pane_id: "w1:p6",
            agent: "claude",
            label: `executor #${body.run.id}-2`,
          },
        ],
      },
    }),
  });
  try {
    writeFileSync(fixturePath, "initial\n");
    commitWorktree("add Verify lifecycle fixture");
    const firstAdvance = transition("advance-to-verify");
    expect(firstAdvance.exitCode, firstAdvance.stderr).toBe(0);

    const firstVerify = launch("verify", firstRuntime.dir, firstRuntime.log);
    expect(firstVerify.exitCode, firstVerify.stderr).toBe(0);
    expect(firstVerify.stdout).toContain(`agent\tverifier #${body.run.id}-1`);
    expect(readFileSync(firstRuntime.log, "utf8")).not.toContain("pane close");
    expectUnrelatedHerdrFocus(firstRuntime);

    const rcReview = postWorkflowReview(1, "request_changes", headSha());
    expect(rcReview.exitCode, rcReview.stderr).toBe(0);
    const rework = transition("request-rework");
    expect(rework.exitCode, rework.stderr).toBe(0);

    const reworkExecute = launch("execute", firstRuntime.dir, firstRuntime.log);
    expect(reworkExecute.exitCode, reworkExecute.stderr).toBe(0);
    expect(reworkExecute.stdout).toContain(`agent\texecutor #${body.run.id}-2`);
    expectUnrelatedHerdrFocus(firstRuntime);
    writeFileSync(fixturePath, "reworked\n");
    commitWorktree("rework Verify lifecycle fixture");
    const secondAdvance = transition("advance-to-verify");
    expect(secondAdvance.exitCode, secondAdvance.stderr).toBe(0);

    const freshVerify = launch("verify", freshRuntime.dir, firstRuntime.log);
    expect(freshVerify.exitCode, freshVerify.stderr).toBe(0);
    expect(freshVerify.stdout).toContain(`agent\tverifier #${body.run.id}-3`);
    expectUnrelatedHerdrFocus(freshRuntime);
    const log = readFileSync(firstRuntime.log, "utf8");
    const closeIndex = log.indexOf("pane close w1:p3");
    // The herdr agent name is a slug since 0.7.5; the run-scoped wording lives on the pane label.
    const freshStartIndex = log.indexOf(
      `pane rename w1:p5 verifier #${body.run.id}-3`,
    );
    expect(closeIndex).toBeGreaterThan(-1);
    expect(freshStartIndex).toBeGreaterThan(closeIndex);
    expect(log).not.toContain("pane close w1:p1");
    expect(log).not.toContain("pane close w1:p2");
    expect(log).not.toContain("pane close w1:p4");

    const beforeFailedClose = log.length;
    const failedClose = launch(
      "verify",
      closeFailureRuntime.dir,
      firstRuntime.log,
    );
    expect(failedClose.exitCode).not.toBe(0);
    expect(failedClose.stderr).toContain("Herdr exited with status 42");
    const failedCloseLog = readFileSync(firstRuntime.log, "utf8").slice(
      beforeFailedClose,
    );
    expect(failedCloseLog).toContain("pane close w1:p5");
    expect(failedCloseLog).not.toContain(
      `pane rename w1:p5 verifier #${body.run.id}-4`,
    );
  } finally {
    rmSync(firstRuntime.dir, { recursive: true, force: true });
    rmSync(freshRuntime.dir, { recursive: true, force: true });
    rmSync(closeFailureRuntime.dir, { recursive: true, force: true });
  }
});

test("workflow start --herdr opens the PR worktree workspace and starts the parent in its tab", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Canonical parent session",
    "--body",
    "Do it",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = fakeRuntime({
    focusedState: UNRELATED_HERDR_FOCUS,
    worktreeOpenJson: FRESH_OPEN_JSON,
  });
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_FOCUSED_STATE: runtime.focusedStatePath,
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    // The worktree's own workspace is opened first, then the Workflow parent starts in that
    // workspace's fresh tab (#873).
    expect(log).toMatch(
      /--session me-workflow-start-[a-f0-9]{8} worktree open --cwd .+ --path .+/,
    );
    // The launch creates its own tab in that workspace, then starts the parent in that tab's pane.
    expect(log).toMatch(
      /tab create --workspace w1 --cwd .+ --env LOOPHUB_SESSION_ID=/,
    );
    expect(log).toMatch(/pane send-text w1:p2 .*claude /);
    expect(log.indexOf("worktree open")).toBeLessThan(
      log.indexOf("pane send-text"),
    );
    // The label LoopHub identifies the pane by is written onto the pane.
    expect(log).toMatch(/pane rename w1:p2 orchestrator #\d+/);
    // The empty tab the worktree open seeded is dropped without changing the current focus.
    expect(log).toMatch(/tab close w1:t1/);
    expect(log).not.toContain("workspace focus");
    expect(log).not.toContain("tab focus");
    // #2354: the whole launch is that one typed line — flags, then the prompt read back from the
    // run's prompt file. Nothing is pasted into the agent afterwards.
    expect(log).toContain("'--permission-mode' 'auto'");
    expect(log).toMatch(/"\$\(cat '.+\/parent-prompt\.md'\)"/);
    expect(log).not.toContain("pane send-keys");
    expectUnrelatedHerdrFocus(runtime);
    expect(started.stderr).toContain("Attach with: herdr session attach");
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("CLI usage omits workflow start --auto", () => {
  const result = run([]);
  expect(result.stdout).toContain("lh workflow start");
  expect(result.stdout).not.toContain("--auto");
});

test("workflow start --herdr reuses an already-open PR worktree workspace", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Reused parent session",
    "--body",
    "Do it",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = fakeRuntime({
    focusedState: UNRELATED_HERDR_FOCUS,
    worktreeOpenJson: REUSE_OPEN_JSON,
    tabCreateJson: REUSE_TAB_JSON,
  });
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_FOCUSED_STATE: runtime.focusedStatePath,
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    // A reused workspace gets a genuinely new tab inside it (not the repo-root fallback tab), then
    // the parent starts in that tab — no new conflicting workspace is created.
    expect(log).toMatch(/tab create --workspace w1 /);
    expect(log).toMatch(/pane send-text w1:p2 /);
    expect(log.indexOf("tab create")).toBeLessThan(
      log.indexOf("pane send-text"),
    );
    // Reusing a workspace does not change the current workspace, tab, or pane focus.
    expect(log).not.toContain("workspace focus");
    expect(log).not.toContain("tab focus");
    expectUnrelatedHerdrFocus(runtime);
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start --herdr launches when the reused workspace's new tab id is unavailable", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Fallback parent session",
    "--body",
    "Do it",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = fakeRuntime({
    worktreeOpenJson: REUSE_OPEN_JSON,
    tabCreateJson: JSON.stringify({
      result: { root_pane: { pane_id: "w1:p2" } },
    }),
  });
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    expect(log).toMatch(/tab create --workspace w1 /);
    // The pane is what the agent needs; a tab id is not required to complete the launch.
    expect(log).toMatch(/pane send-text w1:p2 /);
    expect(log).not.toContain("tab focus");
    expect(log).not.toContain("workspace focus");
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start --herdr preserves focus when worktree placement falls back to a repo-root tab", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Fallback tab parent session",
    "--body",
    "Do it",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = fakeRuntime({
    focusedState: UNRELATED_HERDR_FOCUS,
    // An unparseable successful response makes placement fall back to an unscoped tab.
    worktreeOpenJson: "",
  });
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_FOCUSED_STATE: runtime.focusedStatePath,
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    expect(log).toMatch(/tab create /);
    expect(log).not.toContain("tab create --workspace");
    expect(log).not.toContain("workspace focus");
    expect(log).not.toContain("tab focus");
    expectUnrelatedHerdrFocus(runtime);
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start --herdr surfaces a failed parent launch and cleans up its workspace", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Failed parent session",
    "--body",
    "Do it",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = fakeRuntime({
    sendTextExit: 7,
    worktreeOpenJson: FRESH_OPEN_JSON,
  });
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode).toBe(1);
    expect(started.stderr).toContain("herdr failed to start the agent");
    const log = readFileSync(runtime.log, "utf8");
    expect(log).toMatch(/pane send-text /);
    // The fresh workspace this launch created must be torn down when the agent fails to start,
    // rather than left as an empty orphan (herdr refuses to close its last tab, so the whole
    // workspace is closed).
    expect(log).toMatch(/workspace close w1/);
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start launches the configured codingAgent (codex) without requiring claude (#516)", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Codex configured parent",
    "--body",
    "Do it with codex",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = codexOnlyRuntime();
  writeConfig({ codingAgent: "codex" });
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
      },
    );

    // Exit 0 with no `claude` on PATH already proves the Codex launch never required claude.
    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    // The parent launches codex with the config default model in auto mode, as one command line
    // typed into its pane. `--session-id` is not passed to codex.
    expect(log).toMatch(/pane send-text \S+ .*\bcodex '/);
    expect(log).not.toMatch(/pane send-text \S+ .*\bclaude '/);
    expect(log).toContain("'--model' 'gpt-5.6-sol'");
    expect(log).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(log).not.toContain("code_mode");
    expect(log).not.toContain("deferred_executor");
    expect(log).not.toContain("suppress_unstable_features_warning=true");
    expect(log).not.toContain("--session-id");
  } finally {
    clearConfig();
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start --claude-code overrides a codex codingAgent config (#516)", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Explicit claude override",
    "--body",
    "Force claude",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = fakeRuntime();
  writeConfig({ codingAgent: "codex" });
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--claude-code",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    // The explicit flag wins over config: the parent launches claude with a --session-id, using the
    // claude config default model (opus).
    expect(log).toMatch(/pane send-text \S+ .*\bclaude '/);
    expect(log).toContain("'--session-id'");
    expect(log).toContain("'--model' 'opus'");
    expect(log).not.toMatch(/pane send-text \S+ .*\bcodex '/);
  } finally {
    clearConfig();
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start --codex --model overrides the config default model (#516)", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Explicit codex model",
    "--body",
    "Codex custom model",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = fakeRuntime();
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--codex",
        "--model",
        "gpt-custom",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    expect(log).toMatch(/pane send-text \S+ .*\bcodex '/);
    expect(log).toContain("'--model' 'gpt-custom'");
    expect(log).not.toContain("gpt-5.5");
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start --grok launches the grok runtime without requiring claude", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Grok parent session",
    "--body",
    "Do it with grok",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = grokOnlyRuntime();
  try {
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--grok",
        "--herdr",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
      },
    );

    // Exit 0 with no `claude` on PATH already proves the Grok launch never required claude.
    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    // The parent launches grok with the grok config default model, and grok is handed neither
    // `--session-id` (claude-only) nor a sandbox posture (grok has none).
    expect(log).toMatch(/pane send-text \S+ .*\bgrok '/);
    expect(log).not.toMatch(/pane send-text \S+ .*\bclaude '/);
    expect(log).toContain("'--model' 'grok-code-fast-1'");
    expect(log).not.toContain("--session-id");
    expect(log).toContain("--always-approve");
    expect(log).not.toContain("--force");
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start --cursor launches Cursor Agent with its verified flags", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Cursor parent session",
    "--body",
    "Do it with Cursor",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const runtime = fakeRuntime();
  try {
    const cursorHome = join(runtime.dir, "home");
    mkdirSync(cursorHome);
    const started = run(
      [
        "workflow",
        "start",
        issue,
        "--repo",
        REPO,
        "--workflow",
        "standard",
        "--cursor",
        "--herdr",
      ],
      {
        HOME: cursorHome,
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
      },
    );
    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    expect(log).toMatch(/pane send-text \S+ .*\bcursor-agent '/);
    expect(log).toContain("'--model' 'auto'");
    expect(log).toContain("--force");
    expect(log).toContain("'--sandbox' 'disabled'");
    expect(log).toContain("--approve-mcps");
    expect(log).not.toContain("--trust");
    expect(log).not.toContain("--print");
    expect(log).not.toContain("--session-id");
    const worktree = started.stdout.match(/worktree\t(.+)/)?.[1]?.trim();
    expect(worktree).toBeTruthy();
    const canonicalWorktree = realpathSync(worktree!);
    const marker = join(
      cursorHome,
      ".cursor",
      "projects",
      canonicalWorktree.replace(/^\//, "").replaceAll("/", "-"),
      ".workspace-trusted",
    );
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      workspacePath: canonicalWorktree,
      trustMethod: "cli-flag",
    });
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});
