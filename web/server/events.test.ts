import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { git, revParse } from "../../core/git.ts";

// Isolate the DB before store.ts -> db.ts runs its import-time setup.
const HOME = mkdtempSync(join(tmpdir(), "lh-events-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let subscribeEvents: typeof import("./events.ts").subscribeEvents;
let S: typeof import("../../core/store.ts");
let repoId: number;

function assistantLine(
  id: string,
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  },
): string {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "claude-sonnet-4-6-20260601",
      usage,
    },
  })}\n`;
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  ({ subscribeEvents } = await import("./events.ts"));
  S = await import("../../core/store.ts");
  const repo = S.createRepo("me/proj", "/tmp/proj");
  repoId = repo.id;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("replays events since the cursor, then delivers live events, then stops on unsubscribe", () => {
  S.emitEvent(repoId, "issue.opened", "me", { number: 1 });
  S.emitEvent(repoId, "issue.opened", "me", { number: 2 });

  const got: number[] = [];
  const unsub = subscribeEvents({ since: 0, repo: "me/proj" }, (n) => {
    expect(n.jsonrpc).toBe("2.0");
    expect(n.method).toBe("events/notify");
    got.push(n.params.id);
  });

  // both past events replayed
  expect(got.length).toBe(2);

  // a live event is delivered
  const live = S.emitEvent(repoId, "issue.closed", "me", { number: 1 }) as any;
  expect(got).toContain(live.id);
  const afterLive = got.length;

  unsub();
  S.emitEvent(repoId, "issue.opened", "me", { number: 3 });
  expect(got.length).toBe(afterLive); // nothing delivered after unsubscribe
});

test("since cursor skips already-seen events on replay", () => {
  const all = S.listEvents(0, repoId, 100);
  const lastId = all[all.length - 1].id;
  const got: number[] = [];
  const unsub = subscribeEvents({ since: lastId, repo: "me/proj" }, (n) =>
    got.push(n.params.id),
  );
  unsub();
  // every replayed id is strictly greater than the cursor
  expect(got.every((id) => id > lastId)).toBe(true);
});

test("an unknown repo filter replays nothing", () => {
  const got: number[] = [];
  const unsub = subscribeEvents({ since: 0, repo: "no/such" }, (n) =>
    got.push(n.params.id),
  );
  unsub();
  expect(got).toEqual([]);
});

// A bare (no "/") repo filter must not match anything, even when a same-named "me/<name>" repo
// exists — core/store's splitName defaults an owner-less name to "me/<name>" for registration,
// but a filter value here is compared as-is against full_name, not re-owner-defaulted.
test("a bare repo filter (no slash) replays nothing even if a same-named me/<name> repo exists", () => {
  const got: number[] = [];
  const unsub = subscribeEvents({ since: 0, repo: "proj" }, (n) =>
    got.push(n.params.id),
  );
  unsub();
  expect(got).toEqual([]);
});

test("startEventTail forwards out-of-process DB writes to the in-process hub", async () => {
  const { startEventTail } = await import("./events.ts");
  const { subscribe } = await import("../../core/event-hub.ts");
  const { db, now } = await import("../../core/db.ts");

  const got: number[] = [];
  const unsub = subscribe((e) => got.push(e.id));
  const stop = startEventTail(20);

  // Simulate another process writing an event: insert directly, bypassing publishEvent.
  const row = db
    .query(
      `INSERT INTO events (repo_id, type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      repoId,
      "issue.opened",
      "cli",
      JSON.stringify({ number: 99 }),
      now(),
    ) as { id: number };

  await new Promise((r) => setTimeout(r, 80)); // let a poll tick run
  stop();
  unsub();

  expect(got).toContain(row.id);
});

test("startPullSweep fires pull_request.updated on head SHA change, no-ops when unchanged", async () => {
  const { startPullSweep } = await import("../../worker/maintenance.ts");

  // Real git repo so revParse(local_path, head_ref) resolves a moving branch head.
  const repoPath = mkdtempSync(join(tmpdir(), "lh-sweep-"));
  await git(repoPath, ["init", "-q", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "t@t.local"]);
  await git(repoPath, ["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "f.txt"), "base\n");
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-qm", "base"]);
  await git(repoPath, ["checkout", "-q", "-b", "loophub/issue-x"]);
  writeFileSync(join(repoPath, "f.txt"), "c1\n");
  await git(repoPath, ["commit", "-qam", "c1"]);

  const repo = S.createRepo("me/sweep", repoPath);
  const pull = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pull.id, "loophub/issue-x", "main", null); // head_sha unset -> first sweep records it

  const countUpdates = () =>
    S.listEvents(0, repo.id, 100).filter(
      (e: any) => e.type === "pull_request.updated",
    ).length;

  const stop = startPullSweep(20);
  try {
    const initialHead = await revParse(repoPath, "loophub/issue-x");
    await waitUntil(
      () => S.getPull(pull.id)!.head_sha === initialHead,
      "pull sweep baseline head",
    );
    expect(countUpdates()).toBe(0);

    // New commit moves the branch head -> next sweep should emit exactly one update.
    writeFileSync(join(repoPath, "f.txt"), "c2\n");
    await git(repoPath, ["commit", "-qam", "c2"]);
    const updatedHead = await revParse(repoPath, "loophub/issue-x");
    await waitUntil(
      () =>
        S.getPull(pull.id)!.head_sha === updatedHead && countUpdates() === 1,
      "pull sweep updated head",
    );
    expect(countUpdates()).toBe(1);

    // No further commits -> unchanged head is a no-op (no new DB write).
    await new Promise((r) => setTimeout(r, 60));
    expect(countUpdates()).toBe(1);
  } finally {
    stop();
  }

  // After stop(), a moving head no longer produces events (interval cleared).
  writeFileSync(join(repoPath, "f.txt"), "c3\n");
  await git(repoPath, ["commit", "-qam", "c3"]);
  await new Promise((r) => setTimeout(r, 60));
  expect(countUpdates()).toBe(1);

  rmSync(repoPath, { recursive: true, force: true });
});

test("startUsageSweep syncs changed session usage and emits linked target events only on updates", async () => {
  const { startUsageSweep } = await import("../../worker/maintenance.ts");

  const originalHome = process.env.HOME;
  process.env.HOME = HOME;

  const sessionId = "99999999-0000-0000-0000-000000000724";
  S.registerAgentSession(
    sessionId,
    "lh-dev",
    sessionId,
    "dev agent",
    "claude-code",
    "dev",
  );
  const repo = S.createRepo("me/usage-sweep", "/tmp/lh-usage-sweep-repo");
  const pull = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pull.id, "loophub/issue-724", "main", null);
  S.linkSession(sessionId, pull.id);

  const projectsDir = join(HOME, ".claude", "projects");
  const projectDir = join(projectsDir, "repo-worktree");
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    assistantLine("msg_1", {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 300,
      output_tokens: 10,
    }),
  );

  const usageEvents = () =>
    S.listEvents(0, repo.id, 100).filter(
      (e: any) => e.type === "agent_session.usage_updated",
    );

  const stop = startUsageSweep(20);
  try {
    await waitUntil(() => usageEvents().length === 1, "first usage event");
    expect(S.listSessionUsage(sessionId)[0]).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
    });
    const first = JSON.parse(usageEvents()[0].payload);
    expect(first).toMatchObject({
      session_id: sessionId,
      messages: 1,
      pr: pull.number,
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(usageEvents()).toHaveLength(1);

    appendFileSync(
      transcript,
      assistantLine("msg_2", {
        input_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 3,
      }),
    );
    await waitUntil(() => usageEvents().length === 2, "second usage event");
    expect(S.listSessionUsage(sessionId)[0]).toMatchObject({
      input_tokens: 107,
      output_tokens: 13,
    });
  } finally {
    stop();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startHerdrInactiveCleanup periodically closes old inactive Herdr panes only", async () => {
  const { startHerdrInactiveCleanup } = await import(
    "../../worker/maintenance.ts"
  );
  const { herdrSessionName } = await import(
    "../../core/terminal/terminal-launch.ts"
  );

  const repoPath = mkdtempSync(join(tmpdir(), "lh-herdr-cleanup-repo-"));
  const repo = S.createRepo("me/herdr-cleanup", repoPath);
  const sessionName = herdrSessionName(repo);

  const FAKE_BIN = mkdtempSync(join(tmpdir(), "lh-herdr-cleanup-bin-"));
  const CALLS_FILE = join(FAKE_BIN, "calls.txt");
  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          agent_status: "inactive",
          inactive_seconds: 601,
          name: "old inactive",
          pane_id: "w1:p1",
        },
        {
          agent_status: "inactive",
          inactive_seconds: 30,
          name: "new inactive",
          pane_id: "w1:p2",
        },
        {
          agent_status: "inactive",
          name: "unknown age",
          pane_id: "w1:p3",
        },
        {
          agent_status: "working",
          inactive_seconds: 3600,
          name: "working",
          pane_id: "w1:p4",
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${CALLS_FILE}`,
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `if [ "$3" = "agent" ]; then printf '%s' '${agents}'; exit 0; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);

  async function waitUntil(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const ORIGINAL_PATH = process.env.PATH;
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  const stop = startHerdrInactiveCleanup(20);
  try {
    await waitUntil(
      () =>
        existsSync(CALLS_FILE) &&
        readFileSync(CALLS_FILE, "utf8").includes("pane close w1:p1"),
      "inactive pane close",
    );
    const calls = readFileSync(CALLS_FILE, "utf8");
    expect(calls).toContain(`--session ${sessionName} agent list`);
    expect(calls).toContain(`--session ${sessionName} pane close w1:p1`);
    expect(calls).not.toContain("pane close w1:p2");
    expect(calls).not.toContain("pane close w1:p3");
    expect(calls).not.toContain("pane close w1:p4");
  } finally {
    stop();
    process.env.PATH = ORIGINAL_PATH;
    rmSync(FAKE_BIN, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});
