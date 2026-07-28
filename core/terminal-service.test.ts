import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ServiceError } from "./errors.ts";

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

beforeAll(async () => {
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// Remove PATH only around the launch so the Herdr ENOENT path is deterministic and cannot depend
// on or mutate an ambient Herdr session. This asserts the two things #483 asks for: a specific
// reason and the exact command to retry locally.
test("terminal.launch attaches a specific reason and the retryable herdr command on launch failure (#483)", async () => {
  const path = initGitRepo();
  await svc.repos.create({ path, name: "me/herdr-launch-svc" });

  let err: ServiceError | undefined;
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    await svc.terminal.launch({
      repo: "me/herdr-launch-svc",
      workflow: "scheduled-task-create",
      prompt: "Create a scheduled task.",
    });
  } catch (e) {
    err = e as ServiceError;
  } finally {
    process.env.PATH = originalPath;
  }

  if (!err) throw new Error("expected terminal.launch to reject");
  expect(err.name).toBe("ServiceError");
  // The retryable command is the eventual agent start after the best-effort Scheduled Task
  // placement hits the same deliberate ENOENT.
  expect(err.data?.command).toMatch(/^herdr /);
  expect(err.data?.command).toContain("agent start");
  expect(err.data?.command).toContain("me-herdr-launch-svc-");
  expect(err.message).toBe("herdr command not found on PATH");
  expect(err.data?.session).toBeUndefined();
});

// terminal.launch does no git/PR work of its own for a worktree-backed run: for workflow-run it
// just spawns `lh workflow start --herdr` (#1007), which owns PR open and worktree provisioning.
// See core/terminal-launch-service.test.ts's "workflow-run spawns `lh workflow start --herdr`"
// suite for the (mocked-spawn) coverage of that call, and cli/dev.test.ts for worktree
// provisioning itself.
