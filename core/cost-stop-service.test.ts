import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-cost-stop-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let herdrSessionName: (repo: {
  full_name: string;
  local_path: string;
}) => string;
let updateConfig: (patch: { devCostLimitUsd?: number }) => unknown;
let worktreeRoot: () => string;
let worktreePath: (root: string, fullName: string, pr: number) => string;

const ORIGINAL_PATH = process.env.PATH;
const FAKE_BIN = join(HOME, "fake-bin");
const SENDKEYS_LOG = join(HOME, "sendkeys.log");

function initGitRepo(): string {
  const path = mkdtempSync(join(HOME, "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  return path;
}

// Write a fake `herdr` onto PATH that replays the three CLI shapes enforceDevCostLimits drives:
//   herdr session list --json                     -> `$1 = session`
//   herdr --session <name> agent list             -> `$3 = agent`
//   herdr --session <name> pane send-keys <p> Esc -> `$3 = pane`  (logs argv; exit `sendKeysExit`)
function installFakeHerdr(
  sessionName: string,
  agentsJson: string,
  sendKeysExit = 0,
): void {
  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `if [ "$3" = "agent" ] && [ "$2" = "${sessionName}" ]; then printf '%s' '${agentsJson}'; exit 0; fi`,
      `if [ "$3" = "pane" ]; then echo "$@" >> '${SENDKEYS_LOG}'; exit ${sendKeysExit}; fi`,
      // Unknown session's agent list: empty.
      `printf '%s' '${JSON.stringify({ result: { agents: [] } })}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
}

function agentListWithPane(paneId: string, foregroundCwd: string): string {
  return JSON.stringify({
    result: {
      agents: [
        {
          agent: "claude",
          agent_status: "working",
          name: "dev",
          pane_id: paneId,
          foreground_cwd: foregroundCwd,
        },
      ],
    },
  });
}

// Create an open PR with a linked primary dev session carrying a known top-level cost.
function makePrWithDevCost(repoName: string, costUsd: number | null) {
  const repo = S.createRepo(repoName, initGitRepo());
  const issue = S.createIssue(repo.id, "issue", "i", "", "me") as {
    id: number;
    number: number;
  };
  const pr = S.createIssue(repo.id, "pull", "p", "", "bot") as {
    id: number;
    number: number;
  };
  const sessionId = `dev-${repoName.replace(/\W/g, "")}`;
  S.registerAgentSession(sessionId, "lh-build", `ext-${sessionId}`);
  S.createPull(
    pr.id,
    `loophub/pr-${pr.number}`,
    "main",
    null,
    issue.id,
    sessionId,
  );
  S.upsertSessionUsage(sessionId, {
    model: "claude-opus-4-8",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: costUsd,
  });
  return { repo, pr, sessionId };
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  ({ herdrSessionName } = await import("./terminal/terminal-launch.ts"));
  ({ updateConfig, worktreeRoot } = await import("./config.ts"));
  ({ worktreePath } = await import("./worktree-path.ts"));
  mkdirSync(FAKE_BIN);
  // Deterministic limit for the whole file: over = $12, under = $5.
  updateConfig({ devCostLimitUsd: 10 });
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(HOME, { recursive: true, force: true });
});

test("stops an over-limit dev agent once: sends Esc, records dev.cost_stopped, then idempotent (#832)", async () => {
  const { repo, pr, sessionId } = makePrWithDevCost("me/over", 12);
  const sessionName = herdrSessionName(repo);
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);
  installFakeHerdr(sessionName, agentListWithPane("wA:p1", prWorktree));
  try {
    const first = await svc.terminal.enforceDevCostLimits();
    expect(first).toEqual({ stopped: 1, skipped: 0, failed: 0 });
    // Esc was actually sent to the resolved pane.
    expect(readFileSync(SENDKEYS_LOG, "utf8")).toContain(
      "pane send-keys wA:p1 Escape",
    );
    // Reason persisted, keyed to this PR + session.
    expect(S.hasCostStopEvent(repo.id, pr.number, sessionId)).toBe(true);

    // Second sweep: the guard skips the already-stopped session — no second Esc.
    rmSync(SENDKEYS_LOG, { force: true });
    const second = await svc.terminal.enforceDevCostLimits();
    expect(second).toEqual({ stopped: 0, skipped: 1, failed: 0 });
    expect(() => readFileSync(SENDKEYS_LOG, "utf8")).toThrow();
  } finally {
    process.env.PATH = ORIGINAL_PATH;
    rmSync(SENDKEYS_LOG, { force: true });
  }
});

test("does not stop a dev agent at or below the limit (#832, AC4)", async () => {
  const { repo, pr, sessionId } = makePrWithDevCost("me/under", 5);
  const sessionName = herdrSessionName(repo);
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);
  installFakeHerdr(sessionName, agentListWithPane("wB:p1", prWorktree));
  try {
    expect(await svc.terminal.enforceDevCostLimits()).toEqual({
      stopped: 0,
      skipped: 1,
      failed: 0,
    });
    expect(S.hasCostStopEvent(repo.id, pr.number, sessionId)).toBe(false);
    expect(() => readFileSync(SENDKEYS_LOG, "utf8")).toThrow();
  } finally {
    process.env.PATH = ORIGINAL_PATH;
    rmSync(SENDKEYS_LOG, { force: true });
  }
});

test("never stops a pane whose cwd is not a PR worktree (#832, AC5)", async () => {
  // A registered active repo with a running session, but the pane's cwd is an unrelated dir — it
  // resolves to no PR, so it is not a candidate and no Esc is sent.
  const repo = S.createRepo("me/unrelated", initGitRepo());
  const sessionName = herdrSessionName(repo);
  installFakeHerdr(
    sessionName,
    agentListWithPane("wC:p1", "/tmp/not-a-worktree"),
  );
  try {
    expect(await svc.terminal.enforceDevCostLimits()).toEqual({
      stopped: 0,
      skipped: 0,
      failed: 0,
    });
    expect(() => readFileSync(SENDKEYS_LOG, "utf8")).toThrow();
  } finally {
    process.env.PATH = ORIGINAL_PATH;
    rmSync(SENDKEYS_LOG, { force: true });
  }
});

test("a failed Esc delivery records no stop, so the next sweep retries (#832, AC6)", async () => {
  const { repo, pr, sessionId } = makePrWithDevCost("me/senderr", 12);
  const sessionName = herdrSessionName(repo);
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);
  // send-keys exits non-zero → runHerdr rejects → the stop is not recorded.
  installFakeHerdr(sessionName, agentListWithPane("wD:p1", prWorktree), 1);
  try {
    expect(await svc.terminal.enforceDevCostLimits()).toEqual({
      stopped: 0,
      skipped: 0,
      failed: 1,
    });
    expect(S.hasCostStopEvent(repo.id, pr.number, sessionId)).toBe(false);
  } finally {
    process.env.PATH = ORIGINAL_PATH;
    rmSync(SENDKEYS_LOG, { force: true });
  }
});

test("returns zero counts when herdr is not running (#832)", async () => {
  // No fake herdr on PATH → `herdr session list` fails → clean no-op.
  process.env.PATH = join(HOME, "empty-bin-missing");
  try {
    expect(await svc.terminal.enforceDevCostLimits()).toEqual({
      stopped: 0,
      skipped: 0,
      failed: 0,
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});
