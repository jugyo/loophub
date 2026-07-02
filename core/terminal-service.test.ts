import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { worktreeRoot } from "./config.ts";
import type { ServiceError } from "./errors.ts";
import { worktreePath } from "./worktree-path.ts";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-terminal-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");

function initGitRepo(): string {
  const path = mkdtempSync(join(HOME, "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  return path;
}

// Like initGitRepo, but with a base commit on the default branch — provisionWorktree needs a
// resolvable default branch to fork the PR's convention branch from.
function initGitRepoWithCommit(): string {
  const path = initGitRepo();
  spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: path });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: path });
  writeFileSync(join(path, "f.txt"), "base\n");
  spawnSync("git", ["add", "-A"], { cwd: path });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: path });
  return path;
}

beforeAll(async () => {
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// A real launch attempt always fails in the test environment — either `herdr` is missing on PATH
// (ENOENT) or it runs and exits non-zero for lack of a real terminal session — exercising the full
// terminal.launch error path without mocking child_process. Either way, this asserts the two
// things #483 asks for: a specific (non-generic) reason and the exact command to retry locally.
test("terminal.launch attaches a specific reason and the retryable herdr command on launch failure (#483)", async () => {
  const path = initGitRepo();
  await svc.repos.create({ path, name: "me/herdr-launch-svc" });

  let err: ServiceError | undefined;
  try {
    await svc.terminal.launch({
      repo: "me/herdr-launch-svc",
      workflow: "issue-create",
    });
  } catch (e) {
    err = e as ServiceError;
  }

  if (!err) throw new Error("expected terminal.launch to reject");
  expect(err.name).toBe("ServiceError");
  // The retryable command must be the actual `herdr ...` invocation (so it can reproduce a
  // herdr-specific failure), not just the inner workflow command run inside the session.
  expect(err.data?.command).toMatch(/^herdr /);
  expect(err.data?.command).toContain("agent start");
  expect(err.data?.command).toContain("lh issue new --repo");
  expect(err.data?.command).toContain("me/herdr-launch-svc");
  expect(err.message).toMatch(
    /^(herdr command not found on PATH|Herdr exited with status \d+|Herdr process was terminated by signal \w+|failed to launch Herdr \(.+\))$/,
  );
  // The session-creation hint only applies to the non-zero-exit case (the one empirically tied to
  // a missing session) — ENOENT/signal-killed have unrelated causes and must NOT carry `session`,
  // or the client would misleadingly suggest creating a session that has nothing to do with it.
  if (/^Herdr exited with status \d+$/.test(err.message)) {
    expect(err.data?.session).toMatch(/^me-herdr-launch-svc-[a-f0-9]{8}$/);
  } else {
    expect(err.data?.session).toBeUndefined();
  }
});

// Build (issue-dev) always fires before a PR exists (the button is hidden once one is open), so
// there is no PR-derived worktree path to hand herdr's `worktree open --path` yet (#551). This
// asserts terminal.launch resolves that ahead of the (always-failing-in-test) herdr call: it opens
// the issue's draft PR and provisions its deterministic worktree on disk, exactly like `lh dev
// <issue>` would once it started running inside the tab this launch would have opened.
test("issue-dev launch opens the PR and provisions its worktree ahead of the herdr call (#551)", async () => {
  const path = initGitRepoWithCommit();
  await svc.repos.create({ path, name: "me/herdr-worktree-svc" });
  const issue = svc.issues.create("me/herdr-worktree-svc", {
    title: "worktree-open target",
  });

  let err: ServiceError | undefined;
  try {
    await svc.terminal.launch({
      repo: "me/herdr-worktree-svc",
      workflow: "issue-dev",
      issueNumber: issue.number,
    });
  } catch (e) {
    err = e as ServiceError;
  }
  // herdr is unavailable in the test environment, so the launch itself still fails — see the
  // #483 test above. What matters here is what happened *before* that failure.
  if (!err) throw new Error("expected terminal.launch to reject");

  const detail = svc.issues.get("me/herdr-worktree-svc", issue.number) as {
    linked_pull_request?: { number: number };
  };
  const prNumber = detail.linked_pull_request?.number;
  expect(prNumber).toBeTypeOf("number");

  const wtPath = worktreePath(
    worktreeRoot(),
    "me/herdr-worktree-svc",
    prNumber as number,
  );
  expect(existsSync(wtPath)).toBe(true);
  expect(existsSync(join(wtPath, "f.txt"))).toBe(true);
});
