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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { git, worktreeAdd } from "../core/git.ts";
import { WORKFLOW_PATH } from "../core/workflow.ts";

// Isolate HOME/DB before db.ts runs its import-time setup (see AGENTS.md test convention).
const HOME = mkdtempSync(join(tmpdir(), "lh-worker-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("../core/store.ts");
let R: typeof import("./runner.ts");
let P: typeof import("./diff-feedback-projection.ts");
let svc: typeof import("../core/service.ts");

// Init a git repo whose working tree is the repo's local_path, with a workflow.yml.
async function makeRepo(workflowYml: string): Promise<string> {
  const p = mkdtempSync(join(tmpdir(), "lh-repo-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "f.txt"), "base\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);
  mkdirSync(join(p, ".loophub"), { recursive: true });
  writeFileSync(join(p, WORKFLOW_PATH), workflowYml);
  return p;
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  S = await import("../core/store.ts");
  svc = await import("../core/service.ts");
  R = await import("./runner.ts");
  P = await import("./diff-feedback-projection.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("issue.opened runs steps in repo cwd with LH_* env; a failing step does not stop the rest", async () => {
  const repoPath = await makeRepo(
    [
      "on:",
      "  issue.opened:",
      '    - run: printf "%s|%s|%s" "$LH_EVENT_TYPE" "$LH_REPO" "$LH_ISSUE_NUMBER" > env.out',
      "    - run: exit 3", // failing step in the middle
      "    - run: touch after-failure.out", // must still run
      "",
    ].join("\n"),
  );
  const repo = S.createRepo("jugyo/wf-issue", repoPath);
  const issue = S.createIssue(repo.id, "issue", "hi", "", "me") as any;
  const row = S.emitEvent(repo.id, "issue.opened", "me", {
    number: issue.number,
  });

  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  await R.dispatchEvent(row);

  // cwd was the repo's local_path and the env was populated.
  expect(readFileSync(join(repoPath, "env.out"), "utf8")).toBe(
    `issue.opened|jugyo/wf-issue|${issue.number}`,
  );
  // The step after the failing one still ran.
  expect(existsSync(join(repoPath, "after-failure.out"))).toBe(true);

  // run_started/run_completed pairs were emitted for all three steps, with the failure recorded.
  const events = S.listEvents(row.id, repo.id, 100);
  const started = events.filter((e: any) => e.type === "workflow.run_started");
  const completed = events.filter(
    (e: any) => e.type === "workflow.run_completed",
  );
  expect(started.length).toBe(3);
  expect(completed.length).toBe(3);
  const codes = completed.map((e: any) => JSON.parse(e.payload).exit_code);
  expect(codes).toEqual([0, 3, 0]);

  // Full output is captured to the per-event log file.
  const logFile = JSON.parse(completed[0].payload).log;
  expect(existsSync(logFile)).toBe(true);

  const stdoutLines = out.mock.calls.map(([message]) => String(message));
  expect(stdoutLines).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        `lh-worker: workflow step started repo=jugyo/wf-issue event_id=${row.id} event_type=issue.opened issue=${issue.number} pr=- task=workflow-step-1`,
      ),
      expect.stringContaining(
        `lh-worker: workflow step failed repo=jugyo/wf-issue event_id=${row.id} event_type=issue.opened issue=${issue.number} pr=- task=workflow-step-2 exit_code=3`,
      ),
      expect.stringContaining(
        `lh-worker: workflow step completed repo=jugyo/wf-issue event_id=${row.id} event_type=issue.opened issue=${issue.number} pr=- task=workflow-step-3 exit_code=0`,
      ),
    ]),
  );
  out.mockRestore();

  rmSync(repoPath, { recursive: true, force: true });
});

test("diff feedback projection is independent from workflow dispatch", async () => {
  const repoPath = await makeRepo("");
  const repo = S.createRepo("jugyo/feedback-cache", repoPath);
  const pr = S.createIssue(repo.id, "pull", "feat", "", "bot");
  S.createPull(pr.id, "feature", "main", null);
  const precompute = vi
    .spyOn(svc.diffFeedback, "precompute")
    .mockResolvedValue(1);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const rows = [
      S.emitEvent(repo.id, "pull_request.updated", "bot", {
        number: pr.number,
      }),
      S.emitEvent(repo.id, "pull_request.updated", "bot", {
        number: pr.number,
        sha: "a".repeat(40),
      }),
      S.emitEvent(repo.id, "pull_request.diff_feedback_created", "bot", {
        number: pr.number,
      }),
    ];
    for (const row of rows) {
      await R.dispatchEvent(row);
    }
    expect(precompute).not.toHaveBeenCalled();

    await P.projectDiffFeedbackEvent(rows[0]);
    await P.projectDiffFeedbackEvent(rows[1]);
    await P.projectDiffFeedbackEvent(rows[2]);
    expect(precompute).toHaveBeenNthCalledWith(
      1,
      "jugyo/feedback-cache",
      pr.number,
    );
    expect(precompute).toHaveBeenNthCalledWith(
      2,
      "jugyo/feedback-cache",
      pr.number,
    );
    expect(precompute).toHaveBeenCalledTimes(2);
    precompute.mockRejectedValueOnce(new Error("cache failed"));
    await expect(
      P.projectDiffFeedbackEvent(
        S.emitEvent(repo.id, "pull_request.updated", "bot", {
          number: pr.number,
          sha: "b".repeat(40),
        }),
      ),
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(
        `diff feedback projection error event_id=${rows[2].id + 1} event_type=pull_request.updated repo=jugyo/feedback-cache pr=${pr.number}`,
      ),
      expect.any(Error),
    );
  } finally {
    errors.mockRestore();
    precompute.mockRestore();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("pull_request.opened sets LH_WORKTREE_PATH from git worktree list when head_ref matches", async () => {
  const repoPath = await makeRepo(
    [
      "on:",
      "  pull_request.opened:",
      '    - run: printf "%s" "$LH_WORKTREE_PATH" > wt.out',
      "",
    ].join("\n"),
  );
  const repo = S.createRepo("jugyo/wf-pr", repoPath);

  // Create a linked worktree on the PR's head branch.
  const wtPath = join(repoPath, "..", `wt-${repoPath.split("/").pop()}`);
  await worktreeAdd(repoPath, wtPath, "loophub/issue-1", "main");
  // The worktree gets its own copy of workflow.yml from the branch; the run executes in the
  // repo's local_path (primary checkout), which is what we assert below.

  const pr = S.createIssue(repo.id, "pull", "feat", "", "bot") as any;
  S.createPull(pr.id, "loophub/issue-1", "main", "abc123", null);
  const row = S.emitEvent(repo.id, "pull_request.opened", "bot", {
    number: pr.number,
  });

  await R.dispatchEvent(row);

  // git worktree list reports the canonical (realpath) form, so compare against that.
  expect(readFileSync(join(repoPath, "wt.out"), "utf8")).toBe(
    realpathSync(wtPath),
  );

  await git(repoPath, ["worktree", "remove", "--force", wtPath]);
  rmSync(repoPath, { recursive: true, force: true });
});

test("pull_request.opened sets LH_WORKTREE_PATH empty when head_ref has no worktree", async () => {
  const repoPath = await makeRepo(
    [
      "on:",
      "  pull_request.opened:",
      '    - run: printf "[%s]" "$LH_WORKTREE_PATH" > wt.out',
      "",
    ].join("\n"),
  );
  const repo = S.createRepo("jugyo/wf-pr-nowt", repoPath);
  const pr = S.createIssue(repo.id, "pull", "feat", "", "bot") as any;
  S.createPull(pr.id, "regular-branch", "main", "abc123", null);
  const row = S.emitEvent(repo.id, "pull_request.opened", "bot", {
    number: pr.number,
  });

  await R.dispatchEvent(row);

  expect(readFileSync(join(repoPath, "wt.out"), "utf8")).toBe("[]"); // empty path

  rmSync(repoPath, { recursive: true, force: true });
});

test("events without a workflow.yml or unsupported types are no-ops", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "lh-repo-"));
  await git(repoPath, ["init", "-q", "-b", "main"]); // no .loophub/workflow.yml
  const repo = S.createRepo("jugyo/wf-none", repoPath);
  const row = S.emitEvent(repo.id, "issue.opened", "me", { number: 1 });
  await expect(R.dispatchEvent(row)).resolves.toBeUndefined();
  rmSync(repoPath, { recursive: true, force: true });
});

test("issue.closed ignores an earlier linked workflow pane and cleans the New Issue pane", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "lh-repo-"));
  await git(repoPath, ["init", "-q", "-b", "main"]);
  const repo = S.createRepo("jugyo/new-issue-cleanup", repoPath);
  const target = S.createIssue(repo.id, "issue", "target", "", "me") as any;
  const other = S.createIssue(repo.id, "issue", "other", "", "me") as any;
  S.updateIssue(target.id, { state: "closed" });
  S.updateIssue(other.id, { state: "closed" });
  S.registerHerdrPane({
    launchId: "workflow-launch",
    repoId: repo.id,
    paneId: "wWorkflow:p1",
    sessionName: "workflow-session",
    displayName: "Workflow",
    origin: "workflow",
  });
  S.linkHerdrPaneResource({
    launchId: "workflow-launch",
    repoId: repo.id,
    resourceKind: "issue",
    resourceKey: String(target.id),
  });
  S.upsertIssueHerdrPane({
    launchId: "target-launch",
    repoId: repo.id,
    issueId: target.id,
    paneId: "wTarget:p1",
    sessionName: "target-session",
  });
  S.upsertIssueHerdrPane({
    launchId: "other-launch",
    repoId: repo.id,
    issueId: other.id,
    paneId: "wOther:p1",
    sessionName: "other-session",
  });

  const fakeBin = mkdtempSync(join(tmpdir(), "lh-herdr-close-"));
  const callsFile = join(fakeBin, "calls.txt");
  writeFileSync(
    join(fakeBin, "herdr"),
    [
      "#!/bin/sh",
      `echo "$*" >> '${callsFile}'`,
      `if [ "$4" = "process-info" ]; then printf '%s' '{"result":{"process_info":{"foreground_process_group_id":999999}}}'; exit 0; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBin, "herdr"), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    const row = S.emitEvent(repo.id, "issue.closed", "me", {
      number: target.number,
    });

    expect(S.getIssueHerdrPane(target.id)?.launch_id).toBe("target-launch");
    await R.dispatchEvent(row);
    await waitUntil(
      () =>
        existsSync(callsFile) &&
        readFileSync(callsFile, "utf8").includes("pane close wTarget:p1"),
      "linked New Issue pane close",
    );

    expect(killSpy).toHaveBeenCalledWith(-999999, "SIGKILL");
    const calls = readFileSync(callsFile, "utf8");
    expect(calls).toContain(
      "--session target-session pane process-info --pane wTarget:p1",
    );
    expect(calls).toContain("--session target-session pane close wTarget:p1");
    expect(calls).not.toContain("wOther:p1");
    expect(calls).not.toContain("other-session");
    expect(calls).not.toContain("wWorkflow:p1");
    expect(calls).not.toContain("workflow-session");
    expect(
      S.getHerdrPaneByLaunch(repo.id, "target-launch")?.closed_at,
    ).not.toBeNull();
    expect(
      S.listHerdrPanesForResource({
        repoId: repo.id,
        resourceKind: "issue",
        resourceKey: String(target.id),
      }),
    ).toHaveLength(2);
    expect(
      S.listHerdrPaneClaimsForResource({
        repoId: repo.id,
        resourceKind: "issue",
        resourceKey: String(target.id),
      })[0]?.released_at,
    ).not.toBeNull();
  } finally {
    killSpy.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("issue.closed keeps a pane open while another resource has an active claim", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "lh-repo-"));
  await git(repoPath, ["init", "-q", "-b", "main"]);
  const repo = S.createRepo("jugyo/shared-claim-cleanup", repoPath);
  const first = S.createIssue(repo.id, "issue", "first", "", "me") as any;
  const second = S.createIssue(repo.id, "issue", "second", "", "me") as any;
  S.updateIssue(first.id, { state: "closed" });
  for (const issue of [first, second]) {
    S.upsertIssueHerdrPane({
      launchId: "shared-new-issue-launch",
      repoId: repo.id,
      issueId: issue.id,
      paneId: "wShared:p1",
      sessionName: "shared-session",
    });
  }
  try {
    const row = S.emitEvent(repo.id, "issue.closed", "me", {
      number: first.number,
    });
    await R.dispatchEvent(row);

    expect(
      S.getHerdrPaneByLaunch(repo.id, "shared-new-issue-launch")?.closed_at,
    ).toBeNull();
    expect(
      S.listHerdrPaneClaimsForResource({
        repoId: repo.id,
        resourceKind: "issue",
        resourceKey: String(second.id),
      })[0]?.released_at,
    ).toBeNull();
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("issue.closed reports pane close failure and does not mark the pane closed", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "lh-repo-"));
  await git(repoPath, ["init", "-q", "-b", "main"]);
  const repo = S.createRepo("jugyo/failed-claim-cleanup", repoPath);
  const issue = S.createIssue(repo.id, "issue", "target", "", "me") as any;
  S.updateIssue(issue.id, { state: "closed" });
  S.upsertIssueHerdrPane({
    launchId: "failed-close-launch",
    repoId: repo.id,
    issueId: issue.id,
    paneId: "wFailed:p1",
    sessionName: "failed-session",
  });

  const fakeBin = mkdtempSync(join(tmpdir(), "lh-herdr-close-fail-"));
  writeFileSync(
    join(fakeBin, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$4" = "process-info" ]; then printf '%s' '{"result":{"process_info":{"foreground_process_group_id":999998}}}'; exit 0; fi`,
      `if [ "$4" = "close" ]; then exit 1; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBin, "herdr"), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const row = S.emitEvent(repo.id, "issue.closed", "me", {
      number: issue.number,
    });
    await R.dispatchEvent(row);

    expect(errorSpy).toHaveBeenCalledWith(
      `lh-worker: issue close herdr cleanup failed for ${repo.full_name}#${issue.number}`,
    );
    expect(
      S.getHerdrPaneByLaunch(repo.id, "failed-close-launch")?.closed_at,
    ).toBeNull();
  } finally {
    errorSpy.mockRestore();
    killSpy.mockRestore();
    process.env.PATH = originalPath;
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("log path stays under LOOPHUB_HOME/logs even for a repo name with path separators", async () => {
  const repoPath = await makeRepo(
    ["on:", "  issue.opened:", '    - run: "true"', ""].join("\n"),
  );
  // A repo name with `..` segments must not let the log file escape the logs dir.
  const repo = S.createRepo("../evil/..", repoPath);
  const issue = S.createIssue(repo.id, "issue", "x", "", "me") as any;
  const row = S.emitEvent(repo.id, "issue.opened", "me", {
    number: issue.number,
  });

  await R.dispatchEvent(row);

  const logsRoot = realpathSync(join(HOME, "logs"));
  const completed = S.listEvents(row.id, repo.id, 100).find(
    (e: any) => e.type === "workflow.run_completed",
  )!;
  const logFile = realpathSync(JSON.parse(completed.payload).log);
  expect(logFile.startsWith(logsRoot)).toBe(true); // never escaped logs/

  rmSync(repoPath, { recursive: true, force: true });
});
