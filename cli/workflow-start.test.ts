import { spawnSync } from "node:child_process";
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
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-start-home-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-start-repo-"));
const REPO = "me/workflow-start";

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
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

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", REPO_PATH, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
}

// A fake `herdr` that logs every invocation and emits configurable JSON on stdout for the
// worktree-open / tab-create calls the launch orchestration makes, so a test can drive the
// worktree open→reuse dance (`agent start --tab <id>`) the same way `lh build --herdr` does.
// `agentStartExit` fails only the `agent start` call, leaving the earlier open/create succeeding —
// the shape a real failed parent launch takes after its workspace was already created.
function fakeRuntime(
  opts: {
    agentStartExit?: number;
    paneListJson?: string;
    worktreeOpenJson?: string;
    tabCreateJson?: string;
  } = {},
) {
  const {
    agentStartExit = 0,
    paneListJson = "",
    worktreeOpenJson = "",
    tabCreateJson = "",
  } = opts;
  const dir = mkdtempSync(join(tmpdir(), "lh-workflow-runtime-"));
  const log = join(dir, "herdr.log");
  const herdr = join(dir, "herdr");
  const claude = join(dir, "claude");
  const codex = join(dir, "codex");
  writeFileSync(
    herdr,
    `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$HERDR_LOG"
case " $* " in
  *" worktree open "*) printf '%s' '${worktreeOpenJson}'; exit 0 ;;
  *" pane list "*) printf '%s' '${paneListJson}'; exit 0 ;;
  *" tab create "*) printf '%s' '${tabCreateJson}'; exit 0 ;;
  *" agent start "*) exit ${agentStartExit} ;;
esac
exit 0
`,
  );
  writeFileSync(
    claude,
    '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 0\n',
  );
  writeFileSync(codex, '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 0\n');
  chmodSync(herdr, 0o755);
  chmodSync(claude, 0o755);
  chmodSync(codex, 0o755);
  return { dir, log };
}

// A fakeRuntime with no `claude` binary, so a test asserts a Codex launch never requires claude.
function codexOnlyRuntime() {
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
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(REPO_PATH, "README.md"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  const added = run(["repo", "add", REPO_PATH, "--name", REPO]);
  if (added.exitCode !== 0) throw new Error(added.stderr);
  const workflow = run([
    "workflow",
    "create",
    "standard",
    "--description",
    "test",
  ]);
  if (workflow.exitCode !== 0) throw new Error(workflow.stderr);
});

test("workflow step output uses flags before ambient context and supports ambient-only submission", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Workflow output task",
    "--body",
    "Place a plan",
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
  const artifactPath = join(HOME, "plan.json");
  writeFileSync(
    artifactPath,
    JSON.stringify({
      type: "plan",
      summary: "Place the plan.",
      changes: [{ area: "core", description: "Use the service." }],
      reuse: [],
      out_of_scope: [],
      verification: "Inspect the PR body.",
    }),
  );

  const explicit = run(
    [
      "workflow",
      "step",
      "output",
      "--repo",
      REPO,
      "--run",
      String(runResult.run.id),
      "--step",
      "plan",
      "--file",
      artifactPath,
    ],
    { LOOPHUB_WORKFLOW_RUN: "999999", LOOPHUB_WORKFLOW_STEP: "verify" },
  );
  expect(explicit.exitCode).toBe(0);
  expect(explicit.stdout).toContain("placed pr-body-plan at pr-body");

  const ambient = run(
    ["workflow", "step", "output", "--repo", REPO, "--file", artifactPath],
    {
      LOOPHUB_WORKFLOW_RUN: String(runResult.run.id),
      LOOPHUB_WORKFLOW_STEP: "plan",
    },
  );
  expect(ambient.exitCode).toBe(0);
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
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
    current_step: "plan",
    rework_count: 0,
  });
  expect(body.workflow.name).toBe("standard");
  expect(body.issue.number).toBe(Number(issue));
  expect(body.pr.number).toBeGreaterThan(Number(issue));
  expect(existsSync(body.worktree)).toBe(true);
  expect(existsSync(body.lock_path)).toBe(true);
  expect(body.parent.user_prompt).not.toMatch(/^\/lh-/m);
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
          label: `workflow-${body.session_id.slice(0, 8)}`,
        },
        {
          pane_id: "w1:p3",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: `workflow plan #${body.run.id}`,
        },
        {
          pane_id: "w1:p4",
          tab_id: "w1:t2",
          workspace_id: "w1",
          label: "unrelated",
        },
      ],
    },
  });
  const runtime = fakeRuntime({
    paneListJson,
    tabCreateJson: JSON.stringify({
      result: {
        tab: { tab_id: "w1:t3" },
        root_pane: { pane_id: "w1:p10" },
      },
    }),
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
        "plan",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
        HERDR_TAB_ID: "w1:t1",
        LOOPHUB_SESSION_ID: body.session_id,
      },
    );

    expect(launched.exitCode, launched.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    expect(log).toMatch(/agent start .+ --tab w1:t1 /);
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

    const legacyLaunch = run(
      [
        "workflow",
        "launch-step",
        "--repo",
        REPO,
        "--run",
        String(body.run.id),
        "--step",
        "plan",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
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
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
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
  const runtime = fakeRuntime({ worktreeOpenJson: FRESH_OPEN_JSON });
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
    // Same worktree open→agent-start placement a normal `lh build --herdr` performs: the worktree's
    // own workspace is opened first, then the parent starts in that workspace's fresh tab (#873).
    expect(log).toMatch(
      /--session me-workflow-start-[a-f0-9]{8} worktree open --cwd .+ --path .+/,
    );
    expect(log).toMatch(/agent start .+ --tab w1:t1 /);
    expect(log.indexOf("worktree open")).toBeLessThan(
      log.indexOf("agent start"),
    );
    // Detached (`--herdr`) must not steal the user's current herdr selection: even on a successful
    // launch it never focuses the fresh workspace/tab it created (#1250). Placement stays guaranteed
    // by `--tab`/`--workspace`, which is what the `agent start --tab` assertion above verifies.
    expect(log).not.toContain("workspace focus");
    expect(log).not.toContain("tab focus");
    expect(readFileSync(runtime.log, "utf8")).not.toContain(
      "'--permission-mode' 'auto'",
    );
    expect(started.stderr).toContain("Attach with: herdr --session");
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("workflow start --auto launches the parent in auto mode", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "Auto parent session",
    "--body",
    "Do it unattended",
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
        "--herdr",
        "--auto",
      ],
      {
        PATH: `${runtime.dir}:${process.env.PATH}`,
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode, started.stderr).toBe(0);
    expect(readFileSync(runtime.log, "utf8")).toContain(
      "'--permission-mode' 'auto'",
    );
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});

test("CLI usage documents workflow start --auto", () => {
  const result = run([]);
  expect(result.stdout).toContain("lh workflow start");
  expect(result.stdout).toContain("[--herdr] [--auto]");
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
        HERDR_LOG: runtime.log,
      },
    );

    expect(started.exitCode, started.stderr).toBe(0);
    const log = readFileSync(runtime.log, "utf8");
    // A reused workspace gets a genuinely new tab inside it (not the repo-root fallback tab), then
    // the parent starts in that tab — no new conflicting workspace is created.
    expect(log).toMatch(/tab create --workspace w1 /);
    expect(log).toMatch(/agent start .+ --tab w1:t2 /);
    expect(log.indexOf("tab create")).toBeLessThan(log.indexOf("agent start"));
    // As with the fresh-workspace path, the detached reused-workspace launch must not focus the new
    // tab (#1250). This exercises the `tabId` focus branch; together with the fresh test's
    // `createdWorkspace` branch, both post-launch focus paths are covered — and the tab-id-less
    // `--workspace` fallback shares the same `focusOnSuccess` guard.
    expect(log).not.toContain("workspace focus");
    expect(log).not.toContain("tab focus");
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
    agentStartExit: 7,
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
    expect(started.stderr).toContain("herdr exited with status 7");
    const log = readFileSync(runtime.log, "utf8");
    expect(log).toMatch(/agent start /);
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
    // The parent launches codex with the codex config default model and the workspace-write sandbox
    // posture (non-auto). `<bin> '` marks the real binary invocation (the folded prompt escapes its
    // own quotes), so `claude '` never appears and `--session-id` is not passed to codex.
    expect(log).toContain("codex '");
    expect(log).not.toContain("claude '");
    expect(log).toContain("'--model' 'gpt-5.5'");
    expect(log).toContain("'workspace-write'");
    expect(log).not.toContain("'--session-id'");
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
    // claude config default model (opus). `<bin> '` marks the real binary invocation.
    expect(log).toContain("claude '--session-id'");
    expect(log).toContain("'--model' 'opus'");
    expect(log).not.toContain("codex '");
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
    expect(log).toContain("codex '");
    expect(log).toContain("'--model' 'gpt-custom'");
    expect(log).not.toContain("gpt-5.5");
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true });
  }
});
