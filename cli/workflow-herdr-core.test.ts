import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "#loophub-test";
import { callHerdrCore, runHerdrCore } from "../core/herdr-core.ts";

// The whole launch path on a herdr-core repo, through the real CLI and a real core of its own (see
// core/herdr-core.test.ts for how the core is isolated). The agent is a fake `claude` that records
// its argv and then echoes whatever is typed into it, so a test can see both the launch and a send.
const HAS_HC = Bun.which("hc") !== null;
const DIR = mkdtempSync("/tmp/lhwf-");
const HOME = join(DIR, "home");
const BIN = join(DIR, "bin");
const AGENT_LOG = join(DIR, "agents");
const REPO_PATH = join(DIR, "repo");
const REPO = "me/workflow-herdr-core";
const hcEnv = {
  HC_SESSION: "lhwf",
  XDG_STATE_HOME: join(DIR, "s"),
  XDG_CONFIG_HOME: join(DIR, "c"),
  XDG_RUNTIME_DIR: join(DIR, "r"),
};
const PREVIOUS_ENV = { ...process.env };
Object.assign(process.env, hcEnv, {
  LOOPHUB_HOME: HOME,
  LOOPHUB_DB: join(HOME, "loophub.db"),
  PATH: `${BIN}:${process.env.PATH}`,
});
delete process.env.HC_SOCKET;
delete process.env.HC_TERMINAL_ID;

let svc: typeof import("../core/service.ts");
let S: typeof import("../core/store.ts");
let db: typeof import("../core/db.ts").db;

function run(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "index.ts"), ...args],
    { encoding: "utf8", env: process.env, cwd: REPO_PATH },
  );
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", REPO_PATH, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

type Terminal = {
  address: string;
  state: string;
  parent: string | null;
  notify: boolean;
  cwd: string;
  labels: Record<string, string>;
};

function terminal(address: string): Promise<Terminal> {
  return callHerdrCore("terminal.get", {
    terminal: address,
  }) as Promise<Terminal>;
}

async function eventually<T>(read: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

// The argv the fake agent recorded, one entry per argument, for the terminal that started it.
function agentArgv(address: string): Promise<string[]> {
  return eventually(() =>
    JSON.parse(readFileSync(join(AGENT_LOG, `${address}.json`), "utf8")),
  );
}

const FAKE_CLAUDE = `#!/usr/bin/env bun
const { writeFileSync } = require("node:fs");
writeFileSync(
  ${JSON.stringify(AGENT_LOG)} + "/" + process.env.HC_TERMINAL_ID + ".json",
  JSON.stringify(process.argv.slice(2)),
);
process.stdin.pipe(process.stdout);
`;

afterAll(async () => {
  if (HAS_HC) await runHerdrCore(["server", "stop"]);
  process.env = PREVIOUS_ENV;
  rmSync(DIR, { recursive: true, force: true });
});

describe.skipIf(!HAS_HC)("a herdr-core repo", () => {
  let runId: number;
  let parentSession: string;
  let parentAddress: string;
  let executorAddress: string;
  let pr: number;

  beforeAll(async () => {
    mkdirSync(HOME);
    mkdirSync(BIN);
    mkdirSync(AGENT_LOG);
    mkdirSync(REPO_PATH);
    writeFileSync(join(BIN, "claude"), FAKE_CLAUDE, { mode: 0o755 });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.local"]);
    git(["config", "user.name", "tester"]);
    writeFileSync(join(REPO_PATH, "README.md"), "hello\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    expect(
      run(["repo", "add", realpathSync(REPO_PATH), "--name", REPO]).code,
    ).toBe(0);
    expect(
      run(["workflow", "create", "standard", "--description", "test"]).code,
    ).toBe(0);
    svc = await import("../core/service.ts");
    S = await import("../core/store.ts");
    ({ db } = await import("../core/db.ts"));
    svc.repos.setTerminalBackend(REPO, "herdr-core");
  });

  test("workflow start runs the parent in a labelled top-level terminal", async () => {
    const created = run([
      "issue",
      "create",
      "--repo",
      REPO,
      "--title",
      "Run me",
      "--body",
      "x",
    ]);
    const issue = created.stdout.match(/created #(\d+)/)?.[1];
    if (!issue) throw new Error(created.stderr);
    const started = run([
      "workflow",
      "start",
      issue,
      "--repo",
      REPO,
      "--workflow",
      "standard",
    ]);
    expect(started.code, started.stderr).toBe(0);
    runId = Number(started.stdout.match(/run #(\d+)/)?.[1]);
    pr = Number(started.stdout.match(/pr\t#(\d+)/)?.[1]);
    parentSession = started.stdout.match(/session\t(\S+)/)?.[1] as string;
    const repo = S.getRepo("me", "workflow-herdr-core");
    if (!repo) throw new Error("repo missing");
    const panes = S.listHerdrPanesForResource({
      repoId: repo.id,
      resourceKind: "workflow_run",
      resourceKey: String(runId),
    });
    expect(panes).toHaveLength(1);
    expect(panes[0].session_name).toBe("herdr-core");
    parentAddress = panes[0].pane_id as string;

    const parent = await terminal(parentAddress);
    expect(parent.parent).toBeNull();
    expect(parent.notify).toBe(false);
    expect(parent.labels).toEqual({
      "loophub.repo": REPO,
      "loophub.pr": String(pr),
      "loophub.run": String(runId),
      "loophub.role": "orchestrator",
    });

    const argv = await agentArgv(parentAddress);
    // The prompt is one argument, whole: it has to contain the run it was written for.
    expect(argv.at(-1)).toContain(`#${runId}`);
    expect(argv.at(-1)).toContain("\n");
  });

  test("launch-step records the child's terminal as its execution target", async () => {
    const launched = run([
      "workflow",
      "launch-step",
      "--repo",
      REPO,
      "--run",
      String(runId),
      "--step",
      "execute",
      "--session-id",
      parentSession,
    ]);
    expect(launched.code, launched.stderr).toBe(0);
    const session = launched.stdout.match(/session\t(\S+)/)?.[1] as string;
    const target = S.getAgentExecutionTarget(session);
    expect(target).toMatchObject({ provider: "herdr-core", context: null });
    executorAddress = target?.target_id as string;

    const child = await terminal(executorAddress);
    expect(child.parent).toBeNull();
    expect(child.notify).toBe(false);
    expect(child.labels).toEqual({
      "loophub.repo": REPO,
      "loophub.pr": String(pr),
      "loophub.run": String(runId),
      "loophub.role": "executor",
      "loophub.seq": "1",
    });
    expect(child.cwd).toContain(`pr-${pr}`);
    const argv = await agentArgv(executorAddress);
    expect(argv).toContain(session);
    expect(argv.at(-1)).toContain(`- run: ${runId}\n`);
  });

  test("a delivery reaches the child through terminal.send", async () => {
    await agentArgv(executorAddress);
    await svc.workflowRuns.deliver(
      REPO,
      { run: runId, target: "executor", text: "please rework this" },
      parentSession,
    );
    await eventually(async () => {
      const read = (await callHerdrCore("terminal.read", {
        terminal: executorAddress,
      })) as { text: string };
      expect(read.text).toContain("please rework this");
    });
  });

  test("the input RPC only reaches a terminal of the same PR", async () => {
    await expect(
      svc.terminal.sendAgentInput({
        repo: REPO,
        pull: pr + 1000,
        paneId: executorAddress,
        text: "nope",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.terminal.sendAgentInput({
        repo: REPO,
        pull: pr,
        paneId: executorAddress,
        text: "human says hi",
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("killAgent ends this repo's terminal and refuses another repo's", async () => {
    const other = (await callHerdrCore("terminal.run", {
      argv: ["sleep", "30"],
      labels: { "loophub.repo": "other/repo" },
      no_parent: true,
      no_notify: true,
    })) as { address: string };
    await expect(
      svc.terminal.killAgent({ repo: REPO, paneId: other.address }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await terminal(other.address)).state).toBe("live");
    await callHerdrCore("terminal.kill", { terminal: other.address });

    await svc.terminal.killAgent({ repo: REPO, paneId: executorAddress });
    expect((await terminal(executorAddress)).state).toBe("finished");
  });

  test("New Issue runs lh in a terminal and registers it for the issue's lifetime", async () => {
    writeFileSync(join(BIN, "lh"), FAKE_CLAUDE, { mode: 0o755 });
    const before = readdirSync(AGENT_LOG);
    const result = await svc.terminal.launch({
      repo: REPO,
      workflow: "issue-create",
      prompt: "file an issue",
      model: "opus",
    });
    expect(result.backend).toBe("herdr-core");
    const address = result.attach?.split(" ").at(-1) as string;
    expect(await agentArgv(address)).toEqual([
      "issue",
      "new",
      "--repo",
      REPO,
      "--model",
      "opus",
      "--prompt",
      "file an issue",
    ]);
    expect(readdirSync(AGENT_LOG).length).toBe(before.length + 1);
    const created = await terminal(address);
    expect(created.labels).toEqual({
      "loophub.repo": REPO,
      "loophub.role": "issue-create",
    });
    const repo = S.getRepo("me", "workflow-herdr-core");
    if (!repo) throw new Error("repo missing");
    expect(S.listIssueHerdrPanes(repo.id).at(-1)).toMatchObject({
      pane_id: address,
      session_name: "herdr-core",
    });

    // Filed and closed: its claim on the terminal is released, which ends it.
    const issue = S.createIssue(repo.id, "issue", "filed", "", "me");
    const pane = S.listIssueHerdrPanes(repo.id).at(-1);
    S.upsertIssueHerdrPane({
      launchId: pane?.launch_id as string,
      repoId: repo.id,
      issueId: issue.id,
    });
    S.updateIssue(issue.id, { state: "closed" });
    await expect(
      svc.terminal.cleanupClosedIssuePanes({
        repo: REPO,
        issueNumber: issue.number,
      }),
    ).resolves.toMatchObject({ closed: 1, failed: 0 });
    expect((await terminal(address)).state).toBe("finished");
  });

  test("the GitHub PR export runs its agent in the PR's worktree", async () => {
    const result = await svc.terminal.launch({
      repo: REPO,
      workflow: "github-pr-export",
      prNumber: pr,
      prompt: "export it",
    });
    const address = result.attach?.split(" ").at(-1) as string;
    expect((await agentArgv(address)).at(-1)).toBe("export it");
    const exported = await terminal(address);
    expect(exported.cwd).toContain(`pr-${pr}`);
    expect(exported.labels).toEqual({
      "loophub.repo": REPO,
      "loophub.pr": String(pr),
      "loophub.role": "github-pr-export",
    });
    const repo = S.getRepo("me", "workflow-herdr-core");
    if (!repo) throw new Error("repo missing");
    expect(S.listHerdrPanesByOrigin(repo.id, "github-pr-export")).toMatchObject(
      [{ pane_id: address, session_name: "herdr-core" }],
    );
    await svc.terminal.killAgent({ repo: REPO, paneId: address });
  });

  test("a GitHub export missing its PR is refused without starting anything", async () => {
    await expect(
      svc.terminal.launch({
        repo: REPO,
        workflow: "github-pr-export",
        prompt: "export it",
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      svc.terminal.launch({ repo: REPO, prompt: "no workflow" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("focusing a terminal is a clear error rather than a herdr call", async () => {
    await expect(
      svc.terminal.focusAgent({ repo: REPO, paneId: "t7" }),
    ).rejects.toThrow("hc attach t7");
  });

  // Merging starts no stop job, so this sweep is all that ends these terminals.
  test("the closed PR sweep ends every terminal of a merged PR once its grace has passed", async () => {
    const repo = S.getRepo("me", "workflow-herdr-core");
    if (!repo) throw new Error("repo missing");
    const makePull = (title: string, merged: "expired" | "fresh" | "open") => {
      const row = S.createIssue(repo.id, "pull", title, "", "me");
      S.createPull(row.id, `feature/${row.number}`, "main", null);
      const session = `session-${row.number}`;
      S.registerAgentSession(session, "lh-workflow", session);
      S.setPullSession(row.id, session);
      if (merged !== "open") S.setMerged(row.id, "sha", "merge");
      if (merged === "expired") {
        db.run("UPDATE pulls SET merged_at = ? WHERE issue_id = ?", [
          new Date(Date.now() - 61 * 60 * 1000)
            .toISOString()
            .replace(/\.\d+Z$/, "Z"),
          row.id,
        ]);
      }
      return row;
    };
    const start = async (number: number, role: string) => {
      const started = (await callHerdrCore("terminal.run", {
        argv: ["sleep", "30"],
        labels: {
          "loophub.repo": REPO,
          "loophub.pr": String(number),
          "loophub.role": role,
        },
        no_parent: true,
        no_notify: true,
      })) as { address: string };
      return started.address;
    };
    const expired = makePull("expired", "expired");
    const fresh = makePull("fresh", "fresh");
    const open = makePull("open", "open");
    // No role is active or inactive to the sweep: all of a PR's terminals go.
    const orchestrator = await start(expired.number, "orchestrator");
    const oldVerifier = await start(expired.number, "verifier");
    const graced = await start(fresh.number, "executor");
    const running = await start(open.number, "executor");

    const result = await svc.terminal.cleanupClosedPullDevAgents();

    expect(result.killed).toBe(2);
    expect(result.failed).toBe(0);
    expect((await terminal(orchestrator)).state).toBe("finished");
    expect((await terminal(oldVerifier)).state).toBe("finished");
    expect((await terminal(graced)).state).toBe("live");
    expect((await terminal(running)).state).toBe("live");
    for (const address of [graced, running])
      await callHerdrCore("terminal.kill", { terminal: address });
  });

  test("closing the PR stops the run's parent", async () => {
    const repo = S.getRepo("me", "workflow-herdr-core");
    const prIssue = repo && S.getIssue(repo.id, pr);
    if (!prIssue) throw new Error("PR missing");
    S.updateIssue(prIssue.id, { state: "closed" });
    await svc.workflowAgentStop.run(REPO, { run: runId });
    expect((await terminal(parentAddress)).state).toBe("finished");
  });

  test("a failed launch is a visible error", async () => {
    const path = process.env.PATH;
    process.env.PATH = join(DIR, "empty");
    try {
      await expect(
        svc.terminal.launch({
          repo: REPO,
          workflow: "issue-create",
          prompt: "x",
        }),
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      process.env.PATH = path;
    }
  });
});
