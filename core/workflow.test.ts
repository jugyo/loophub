import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Worktree } from "./git.ts";
import {
  buildRunEnv,
  loadWorkflow,
  matchWorktreePath,
  normalizeWorkflow,
  parseWorkflow,
  stepsFor,
  WORKFLOW_PATH,
} from "./workflow.ts";

test("parseWorkflow reads the flat on.<event> -> run[] schema", () => {
  const wf = parseWorkflow(`
on:
  issue.opened:
    - run: ./scripts/triage.sh
    - run: lh workflow start "$LH_ISSUE_NUMBER" --workflow default --herdr
  pull_request.opened:
    - run: npm test
`);
  expect(stepsFor(wf, "issue.opened").map((s) => s.run)).toEqual([
    "./scripts/triage.sh",
    'lh workflow start "$LH_ISSUE_NUMBER" --workflow default --herdr',
  ]);
  expect(stepsFor(wf, "pull_request.opened")).toEqual([{ run: "npm test" }]);
  expect(stepsFor(wf, "issue.closed")).toEqual([]);
});

test("normalizeWorkflow drops malformed steps and unknown shapes without throwing", () => {
  const wf = normalizeWorkflow({
    on: {
      "issue.opened": [
        { run: "echo ok" },
        { run: "" }, // empty -> dropped
        { notRun: "x" }, // no run key -> dropped
        "bare string", // not an object -> dropped
      ],
      "pull_request.opened": "not an array", // -> ignored
    },
    extraTopLevel: 123, // unknown key -> ignored
  });
  expect(stepsFor(wf, "issue.opened")).toEqual([{ run: "echo ok" }]);
  expect(stepsFor(wf, "pull_request.opened")).toEqual([]);
});

test("loadWorkflow returns null for a missing file and ignores invalid YAML", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-wf-"));
  try {
    expect(loadWorkflow(dir)).toBeNull(); // no file

    mkdirSync(join(dir, ".loophub"), { recursive: true });
    writeFileSync(
      join(dir, WORKFLOW_PATH),
      "on:\n  issue.opened:\n    - run: echo hi\n",
    );
    expect(stepsFor(loadWorkflow(dir)!, "issue.opened")).toEqual([
      { run: "echo hi" },
    ]);

    // Broken YAML must not throw — loadWorkflow logs and returns null.
    writeFileSync(join(dir, WORKFLOW_PATH), "on: [this: is: invalid: yaml");
    expect(loadWorkflow(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matchWorktreePath matches a PR head ref to a worktree path by branch", () => {
  const worktrees: Worktree[] = [
    { path: "/main", head: "a", branch: "main", bare: false, detached: false },
    {
      path: "/wt/issue-52",
      head: "b",
      branch: "loophub/issue-52",
      bare: false,
      detached: false,
    },
  ];
  expect(matchWorktreePath("loophub/issue-52", worktrees)).toBe("/wt/issue-52");
  expect(matchWorktreePath("feature-x", worktrees)).toBe(""); // no checked-out worktree
  expect(matchWorktreePath(null, worktrees)).toBe("");
});

test("buildRunEnv sets only the variables relevant to the event", () => {
  const issueEnv = buildRunEnv({
    event: { type: "issue.opened", actor: "me", payload: { number: 7 } },
    repoFullName: "jugyo/loophub",
    issueNumber: 7,
  });
  expect(issueEnv).toEqual({
    LH_EVENT_TYPE: "issue.opened",
    LH_REPO: "jugyo/loophub",
    LH_ACTOR: "me",
    LH_EVENT_PAYLOAD: '{"number":7}',
    LH_ISSUE_NUMBER: "7",
  });
  expect(issueEnv.LH_WORKTREE_PATH).toBeUndefined();
  expect(issueEnv.LH_PR_NUMBER).toBeUndefined();

  // PR event with a matched worktree.
  const prEnv = buildRunEnv({
    event: {
      type: "pull_request.opened",
      actor: "bot",
      payload: { number: 3 },
    },
    repoFullName: "jugyo/loophub",
    prNumber: 3,
    worktreePath: "/wt/issue-1",
  });
  expect(prEnv.LH_PR_NUMBER).toBe("3");
  expect(prEnv.LH_WORKTREE_PATH).toBe("/wt/issue-1");

  // PR event with no matching worktree -> LH_WORKTREE_PATH is set but empty.
  const prNoWt = buildRunEnv({
    event: { type: "pull_request.opened", actor: "bot", payload: {} },
    repoFullName: "jugyo/loophub",
    prNumber: 4,
    worktreePath: "",
  });
  expect(prNoWt.LH_WORKTREE_PATH).toBe("");
});
