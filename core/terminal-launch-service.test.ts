import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-tl-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

// Fake child process for scripted `herdr` runs. Everything else (git, etc.) uses the real spawn.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

type ScriptedChild = {
  stdout: EventEmitter;
  stderr: EventEmitter;
} & EventEmitter;

const herdr = vi.hoisted(() => ({
  calls: [] as string[][],
  // One scripted behavior per expected herdr spawn, consumed in order.
  script: [] as Array<(child: ScriptedChild) => void>,
}));

// `lh build --herdr` spawns (#584): issue-dev (Build) launches now go through this instead of
// terminal.launch orchestrating herdr tabs/workspaces itself.
const lhDev = vi.hoisted(() => ({
  calls: [] as string[][],
  script: [] as Array<(child: ScriptedChild) => void>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const scripted = (
    log: string[][],
    script: Array<(child: ScriptedChild) => void>,
    command: string,
    args: string[],
  ) => {
    log.push([command, ...args]);
    const behavior = script.shift();
    const child = new FakeChild();
    queueMicrotask(() => {
      if (behavior) behavior(child);
      else child.emit("close", 0, null);
    });
    return child;
  };
  return {
    ...actual,
    spawn: (command: string, args: string[], opts: object) => {
      if (command === "lh")
        return scripted(lhDev.calls, lhDev.script, command, args);
      if (command === "herdr")
        return scripted(herdr.calls, herdr.script, command, args);
      return actual.spawn(command, args, opts as never);
    },
  };
});

let svc: typeof import("./service.ts");
let repoPath: string;

const TAB_JSON =
  '{"id":"cli:tab:create","result":{"tab":{"tab_id":"w1:t9","workspace_id":"w1"},"type":"tab_created"}}';

// `herdr workspace create` seeds the new workspace with one tab and one empty pane, reported in
// the same shape `herdr tab create` uses, plus the new workspace itself.
const WORKSPACE_JSON =
  '{"id":"cli:workspace:create","result":{"tab":{"tab_id":"w4:t1","workspace_id":"w4"},"type":"workspace_created","workspace":{"workspace_id":"w4"}}}';
const WORKSPACE_JSON_WITH_ROOT_PANE =
  '{"id":"cli:workspace:create","result":{"root_pane":{"pane_id":"w4:p1"},"tab":{"tab_id":"w4:t1","workspace_id":"w4"},"type":"workspace_created","workspace":{"workspace_id":"w4"}}}';

// tabId and workspaceId are parsed independently from the same response — these fixtures cover
// the two ways they can disagree (one field present, the other missing/malformed).
const WORKSPACE_JSON_NO_TAB_ID =
  '{"id":"cli:workspace:create","result":{"tab":{},"type":"workspace_created","workspace":{"workspace_id":"w4"}}}';
// `.result.workspace.workspace_id` is missing, but parseHerdrWorkspaceId falls back to
// `.result.tab.workspace_id`, which is still present — workspaceId still resolves.
const WORKSPACE_JSON_NO_PRIMARY_WORKSPACE_ID =
  '{"id":"cli:workspace:create","result":{"tab":{"tab_id":"w4:t1","workspace_id":"w4"},"type":"workspace_created","workspace":{}}}';
// Neither field carries a usable workspace id — the truly unrecoverable case.
const WORKSPACE_JSON_NO_WORKSPACE_ID_ANYWHERE =
  '{"id":"cli:workspace:create","result":{"tab":{"tab_id":"w4:t1"},"type":"workspace_created","workspace":{}}}';

// Fixtures for the Resume dedup probe (#578): `herdr agent list` then, per agent,
// `herdr pane process-info --pane <id>`.
const AGENT_LIST_EMPTY = '{"result":{"agents":[]}}';
const AGENT_LIST_ONE =
  '{"result":{"agents":[{"agent":"claude","agent_status":"working","name":"Resume - dev","pane_id":"w1:p2"}]}}';
const PROCESS_INFO_MATCHING_RESUME =
  '{"result":{"process_info":{"foreground_processes":[{"argv":["claude","--resume","session-1"]}]}}}';
const PROCESS_INFO_OTHER_SESSION =
  '{"result":{"process_info":{"foreground_processes":[{"argv":["claude","--resume","some-other-session"]}]}}}';
// A pane_id shaped like a flag (fails HERDR_ID) — must never be spliced into a further `herdr`
// argv (#578 review), so it should be filtered out before any process-info/focus call.
const AGENT_LIST_MALFORMED_PANE_ID =
  '{"result":{"agents":[{"agent":"claude","agent_status":"working","name":"Resume - dev","pane_id":"--evil-flag"}]}}';

function exitWith(status: number, stdout?: string) {
  return (child: ScriptedChild) => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", status, null);
  };
}

function exitWithStderr(status: number, stderrText: string) {
  return (child: ScriptedChild) => {
    child.stderr.emit("data", Buffer.from(stderrText));
    child.emit("close", status, null);
  };
}

function killedBySignal(signal: string) {
  return (child: ScriptedChild) => {
    child.emit("close", null, signal);
  };
}

beforeAll(async () => {
  svc = await import("./service.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-tl-repo-"));
  const git = (args: string[]) =>
    spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

beforeEach(() => {
  herdr.calls.length = 0;
  herdr.script.length = 0;
  lhDev.calls.length = 0;
  lhDev.script.length = 0;
});

// issue-dev (Build): worktree/PR provisioning and the herdr launch itself are entirely
// `lh build --herdr`'s job now (#584) — terminal.launch just spawns it and reports the outcome, no
// tab/workspace orchestration of its own (unlike the other workflows below).
describe("terminal.launch issue-dev spawns `lh build --herdr` (#584)", () => {
  test("spawns `lh build <repo>/<issue> --herdr` and reports the herdr session", async () => {
    lhDev.script.push(exitWith(0));

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
    });

    expect(lhDev.calls).toEqual([["lh", "build", "me/proj/1", "--herdr"]]);
    expect(herdr.calls).toHaveLength(0);
    expect(result).toMatchObject({ backend: "herdr" });
    expect(result.session_name).toBeTruthy();
    expect(result.attach).toContain(result.session_name);
  });

  test("requires issueNumber", async () => {
    await expect(
      svc.terminal.launch({ repo: "me/proj", workflow: "issue-dev" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(lhDev.calls).toHaveLength(0);
  });

  test("appends --auto when the resolved agent's autoModeOnBuild is enabled (#499, #593)", async () => {
    lhDev.script.push(exitWith(0));
    // The Build button doesn't pick a runtime itself, so it reads the auto-mode value for
    // whichever agent `codingAgent` (default claude-code) resolves to.
    svc.settings.update({ agent: "claude-code", autoModeOnBuild: true });

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
    });

    expect(lhDev.calls[0]).toContain("--auto");

    svc.settings.update({ agent: "claude-code", autoModeOnBuild: false });
  });

  test("does not append --auto when a different agent's autoModeOnBuild is enabled (#593)", async () => {
    lhDev.script.push(exitWith(0));
    svc.settings.update({ agent: "codex", autoModeOnBuild: true });

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
    });

    expect(lhDev.calls[0]).not.toContain("--auto");

    svc.settings.update({ agent: "codex", autoModeOnBuild: false });
  });

  test("forwards the dropdown agent/model override as --codex --model (#637)", async () => {
    lhDev.script.push(exitWith(0));

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
      agent: "codex",
      model: "gpt-5.5",
    });

    expect(lhDev.calls).toEqual([
      ["lh", "build", "me/proj/1", "--herdr", "--codex", "--model", "gpt-5.5"],
    ]);
  });

  test("forces --claude-code when the override picks it over a codex default (#637)", async () => {
    lhDev.script.push(exitWith(0));
    svc.settings.update({ codingAgent: "codex" });

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
      agent: "claude-code",
    });

    expect(lhDev.calls[0]).toEqual([
      "lh",
      "build",
      "me/proj/1",
      "--herdr",
      "--claude-code",
    ]);

    svc.settings.update({ codingAgent: "claude-code" });
  });

  test("reads auto-mode from the overridden agent, not the default (#637, #593)", async () => {
    lhDev.script.push(exitWith(0));
    // Default agent is claude-code (auto off); enable auto on codex only, then override to codex.
    svc.settings.update({ agent: "codex", autoModeOnBuild: true });

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
      agent: "codex",
    });

    expect(lhDev.calls[0]).toContain("--auto");

    svc.settings.update({ agent: "codex", autoModeOnBuild: false });
  });

  test("omits --model when the override model is blank (#637)", async () => {
    lhDev.script.push(exitWith(0));

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
      agent: "claude-code",
      model: "   ",
    });

    expect(lhDev.calls[0]).not.toContain("--model");
  });

  test("surfaces a non-zero exit as a ServiceError with a reproducible command", async () => {
    lhDev.script.push(exitWith(1));

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-dev", issueNumber: 1 })
      .then(
        () => null,
        (e: unknown) => e as { message: string; data?: { command?: string } },
      );

    expect(err?.message).toBe("lh build exited with status 1");
    expect(err?.data?.command).toBe("lh build me/proj/1 --herdr");
  });

  test("reports lh missing from PATH distinctly from a launch failure", async () => {
    lhDev.script.push((child) =>
      child.emit(
        "error",
        Object.assign(new Error("spawn lh ENOENT"), { code: "ENOENT" }),
      ),
    );

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-dev", issueNumber: 1 })
      .then(
        () => null,
        (e: unknown) => e as { status: number; message: string },
      );

    expect(err?.status).toBe(422);
    expect(err?.message).toBe("lh command not found on PATH");
  });

  test("logs a bounded stderr tail server-side, but never in the client-facing error (#584 security review)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    lhDev.script.push(exitWithStderr(1, "error 404: Not Found\n"));

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-dev", issueNumber: 1 })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    // The client-facing message stays generic — raw `lh build` stderr can embed the server's
    // absolute paths or a stack trace, so it must never reach the RPC caller.
    expect(err?.message).toBe("lh build exited with status 1");
    expect(
      consoleError.mock.calls.some((call) =>
        String(call[0]).includes("error 404: Not Found"),
      ),
    ).toBe(true);

    consoleError.mockRestore();
  });

  test("surfaces a signal-killed child distinctly from a plain exit", async () => {
    lhDev.script.push(killedBySignal("SIGKILL"));

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-dev", issueNumber: 1 })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    expect(err?.message).toBe("lh build was terminated by signal SIGKILL");
  });

  test("times out and kills the child if lh build hangs, logging any stderr it printed before wedging", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      // Prints diagnostic output, then never emits close/error — simulates a hang mid-run.
      lhDev.script.push((child) =>
        child.stderr.emit("data", Buffer.from("provisioning worktree...\n")),
      );
      const pending = svc.terminal.launch({
        repo: "me/proj",
        workflow: "issue-dev",
        issueNumber: 1,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        message: expect.stringMatching(/^lh build timed out after \d+ms$/),
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(
        consoleError.mock.calls.some((call) =>
          String(call[0]).includes("provisioning worktree..."),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });
});

describe("terminal.launch new-workspace orchestration for New Issue (#544)", () => {
  test("creates a new workspace (not a tab in the existing session) and starts the agent in it", async () => {
    herdr.script.push(exitWith(0, WORKSPACE_JSON), exitWith(0), exitWith(0));

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    expect(herdr.calls[0]).toContain("workspace");
    expect(herdr.calls[0]).toContain("create");
    expect(herdr.calls[0]).not.toContain("tab");
    const agentStart = herdr.calls[1];
    expect(agentStart).toContain("start");
    expect(agentStart[agentStart.indexOf("--tab") + 1]).toBe("w4:t1");
    expect(result).toMatchObject({ backend: "herdr" });
  });

  // Once the agent is running in the new workspace, herdr's active workspace should switch to
  // it automatically (#556) rather than leaving it selectable only by hand.
  test("focuses the newly created workspace once the agent has started (#556)", async () => {
    herdr.script.push(exitWith(0, WORKSPACE_JSON), exitWith(0), exitWith(0));

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    // Fire-and-forget: wait for the queued focus spawn to happen.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(3));
    const focus = herdr.calls[2];
    expect(focus).toContain("workspace");
    expect(focus).toContain("focus");
    expect(focus).toContain("w4");
  });

  test("other workflows keep creating a tab in the existing session, not a new workspace, then focus that tab (#625)", async () => {
    // Resume dedup (#578) probes for an existing pane first; an empty agent list means nothing
    // to find, so the normal tab-creating flow runs after it.
    herdr.script.push(
      exitWith(0, AGENT_LIST_EMPTY),
      exitWith(0, TAB_JSON),
      exitWith(0),
      exitWith(0),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "resume",
      session: "session-1",
    });

    expect(herdr.calls[0]).toContain("list");
    expect(herdr.calls[1]).toContain("tab");
    expect(herdr.calls[1]).not.toContain("workspace");
    // #625: the freshly created tab (not a new workspace) is brought to the front by tab id, so
    // the launched terminal is visible instead of hidden behind whatever was focused.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(4));
    const focus = herdr.calls[3];
    expect(focus).toContain("tab");
    expect(focus).toContain("focus");
    expect(focus).toContain("w1:t9");
    expect(focus).not.toContain("workspace");
  });

  test("closes the whole workspace (not just its tab) when the agent fails to start", async () => {
    herdr.script.push(exitWith(0, WORKSPACE_JSON), exitWith(3), exitWith(0));

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-create", label: "New issue" })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    expect(err?.message).toBe("Herdr exited with status 3");
    // Fire-and-forget cleanup: wait for the queued workspace-close spawn to happen.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(3));
    const cleanup = herdr.calls[2];
    expect(cleanup).toContain("workspace");
    expect(cleanup).toContain("close");
    expect(cleanup).toContain("w4");
  });

  test("closes the seeded root pane once the agent has started, same as the tab path", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_JSON_WITH_ROOT_PANE),
      exitWith(0),
      exitWith(0),
      exitWith(0),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    // Focus (#556) and the root-pane close are both fire-and-forget, queued in that order.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(4));
    const focus = herdr.calls[2];
    expect(focus).toContain("workspace");
    expect(focus).toContain("focus");
    const paneClose = herdr.calls[3];
    expect(paneClose).toContain("pane");
    expect(paneClose).toContain("close");
    expect(paneClose).toContain("w4:p1");
  });

  // tabId and workspaceId are parsed independently from the same `herdr workspace create`
  // response, so they are not guaranteed to succeed/fail together.
  test("closes the orphaned workspace immediately when its seeded tab id fails to parse", async () => {
    // Workspace create succeeds and yields a workspaceId, but no tabId — the workspace can never
    // be targeted (no --tab to route into it), so it must be closed right away rather than left
    // for the (in this case unreachable) failure-only cleanup. Agent start still runs as a
    // tab-less fallback launch.
    herdr.script.push(exitWith(0, WORKSPACE_JSON_NO_TAB_ID), exitWith(0));

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    await vi.waitFor(() => expect(herdr.calls).toHaveLength(3));
    const workspaceClose = herdr.calls[1];
    expect(workspaceClose).toContain("workspace");
    expect(workspaceClose).toContain("close");
    expect(workspaceClose).toContain("w4");
    const agentStart = herdr.calls[2];
    expect(agentStart).toContain("start");
    expect(agentStart).not.toContain("--tab");
  });

  test("still closes the workspace (via the tab's own workspace_id field) when the primary workspace_id field fails to parse", async () => {
    // `.result.workspace.workspace_id` is missing, but `.result.tab.workspace_id` carries the
    // same id — parseHerdrWorkspaceId falls back to it, so cleanup still targets the workspace
    // instead of attempting a tab close that herdr would refuse (a workspace's last tab).
    herdr.script.push(
      exitWith(0, WORKSPACE_JSON_NO_PRIMARY_WORKSPACE_ID),
      exitWith(3),
      exitWith(0),
    );

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-create", label: "New issue" })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    expect(err?.message).toBe("Herdr exited with status 3");
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(3));
    const cleanup = herdr.calls[2];
    expect(cleanup).toContain("workspace");
    expect(cleanup).toContain("close");
    expect(cleanup).toContain("w4");
  });

  test("falls back to a best-effort tab close when no workspace id is recoverable from either field", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_JSON_NO_WORKSPACE_ID_ANYWHERE),
      exitWith(3),
      exitWith(0),
    );

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-create", label: "New issue" })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    expect(err?.message).toBe("Herdr exited with status 3");
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(3));
    const cleanup = herdr.calls[2];
    expect(cleanup).toContain("tab");
    expect(cleanup).toContain("close");
    expect(cleanup).toContain("w4:t1");
  });
});

describe("terminal.launch worktree-workspace reuse focus (#625)", () => {
  // The already-open branch of acquireHerdrWorktreeTab: herdr's worktree workspace already exists,
  // so a new tab is added inside it (createdWorkspace false, workspaceId null). Before #625 this
  // path switched nothing, leaving the launched terminal hidden — now the freshly added tab is
  // brought to the front by tab id.
  const WORKTREE_ALREADY_OPEN =
    '{"result":{"already_open":true,"workspace":{"workspace_id":"w7"},"type":"worktree_opened"}}';

  test("focuses the freshly added tab when the worktree workspace is reused, not the workspace", async () => {
    herdr.script.push(
      exitWith(0, AGENT_LIST_EMPTY), // resume dedup probe: nothing to reuse
      exitWith(0, WORKTREE_ALREADY_OPEN), // worktree open -> already open, reuse workspace w7
      exitWith(0, TAB_JSON), // tab create inside the reused workspace -> w1:t9
      exitWith(0), // agent start
      exitWith(0), // tab focus (fire-and-forget)
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "resume",
      session: "session-1",
      cwd: "/wt/pr-42", // resolves the worktree target so the worktree-open path runs
    });

    expect(herdr.calls[1]).toContain("worktree");
    expect(herdr.calls[1]).toContain("open");
    expect(herdr.calls[2]).toContain("tab");
    expect(herdr.calls[2]).toContain("create");
    const agentStart = herdr.calls[3];
    expect(agentStart[agentStart.indexOf("--tab") + 1]).toBe("w1:t9");

    await vi.waitFor(() => expect(herdr.calls).toHaveLength(5));
    const focus = herdr.calls[4];
    expect(focus).toContain("tab");
    expect(focus).toContain("focus");
    expect(focus).toContain("w1:t9");
    // A reused workspace isn't this launch's to refocus wholesale — only its new tab is selected.
    expect(focus).not.toContain("workspace");
  });
});

describe("terminal.launch Resume dedup (#578)", () => {
  test("focuses an existing pane already running claude --resume <session>, instead of creating a new tab", async () => {
    herdr.script.push(
      exitWith(0, AGENT_LIST_ONE), // agent list
      exitWith(0, PROCESS_INFO_MATCHING_RESUME), // pane process-info for that agent
      exitWith(0), // agent focus
    );

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "resume",
      session: "session-1",
    });

    expect(herdr.calls).toHaveLength(3);
    expect(herdr.calls[0]).toContain("list");
    expect(herdr.calls[1]).toContain("process-info");
    const focus = herdr.calls[2];
    expect(focus).toContain("agent");
    expect(focus).toContain("focus");
    expect(focus).toContain("w1:p2");
    // No tab was created — the whole point of dedup is not piling on another one.
    expect(herdr.calls.some((call) => call.includes("create"))).toBe(false);
    expect(result).toMatchObject({ backend: "herdr", focused: true });
  });

  test("creates a new tab when the only existing pane is resuming a different session (no false-positive name match)", async () => {
    herdr.script.push(
      exitWith(0, AGENT_LIST_ONE), // agent list — pane's display name is "Resume - dev" too
      exitWith(0, PROCESS_INFO_OTHER_SESSION), // but it's actually running a different session
      exitWith(0, TAB_JSON),
      exitWith(0),
      exitWith(0), // tab focus (#625, fire-and-forget)
    );

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "resume",
      session: "session-1",
    });

    expect(herdr.calls[2]).toContain("tab");
    // No dedup match, so no `agent focus` short-circuit (result stays unfocused); the new tab is
    // still brought to the front by tab id (#625).
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(5));
    expect(herdr.calls[4]).toEqual(
      expect.arrayContaining(["tab", "focus", "w1:t9"]),
    );
    expect(result).toMatchObject({ backend: "herdr" });
    expect(result).not.toHaveProperty("focused");
  });

  test("falls back to the normal launch when the dedup probe itself fails (herdr not running yet)", async () => {
    herdr.script.push(
      exitWith(1), // agent list fails
      exitWith(0, TAB_JSON),
      exitWith(0),
    );

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "resume",
      session: "session-1",
    });

    expect(herdr.calls[1]).toContain("tab");
    expect(result).toMatchObject({ backend: "herdr" });
  });

  test("does not run the dedup probe for non-resume workflows", async () => {
    herdr.script.push(exitWith(0, WORKSPACE_JSON), exitWith(0), exitWith(0));

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    expect(herdr.calls.some((call) => call.includes("process-info"))).toBe(
      false,
    );
  });

  // Round 1 quality review: the focus call for a found pane must not surface as a hard failure —
  // the pane can vanish (closed) between the probe and this call, or herdr can be transiently
  // wedged, and a Resume click that would otherwise have succeeded via a fresh tab must not break.
  test("falls back to creating a tab when herdr agent focus fails after finding an existing pane (TOCTOU)", async () => {
    herdr.script.push(
      exitWith(0, AGENT_LIST_ONE), // agent list
      exitWith(0, PROCESS_INFO_MATCHING_RESUME), // pane process-info — matches
      exitWith(3), // agent focus fails (e.g. the pane just closed)
      exitWith(0, TAB_JSON), // falls through to the normal tab-creating flow
      exitWith(0),
    );

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "resume",
      session: "session-1",
    });

    expect(herdr.calls[2]).toContain("focus");
    expect(herdr.calls[3]).toContain("tab");
    expect(result).toMatchObject({ backend: "herdr" });
    expect(result).not.toHaveProperty("focused");
  });

  // Round 1 security review: a pane_id from `herdr agent list` must be validated the same way
  // killAgent validates a client-supplied paneId before it's spliced into a further herdr argv
  // (`pane process-info --pane`, `agent focus`) — a malformed one is dropped instead of probed.
  test("skips an agent whose pane_id fails the HERDR_ID shape check instead of probing or focusing it", async () => {
    herdr.script.push(
      exitWith(0, AGENT_LIST_MALFORMED_PANE_ID), // agent list — one agent, bad pane_id
      exitWith(0, TAB_JSON), // no process-info call happens; falls straight through to normal flow
      exitWith(0),
      exitWith(0), // tab focus (#625, fire-and-forget)
    );

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "resume",
      session: "session-1",
    });

    // list, tab create, agent start, then the #625 tab focus — but no process-info probe.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(4));
    expect(herdr.calls[0]).toContain("list");
    expect(herdr.calls.some((call) => call.includes("process-info"))).toBe(
      false,
    );
    expect(herdr.calls.some((call) => call.includes("--evil-flag"))).toBe(
      false,
    );
    expect(herdr.calls[1]).toContain("tab");
    expect(herdr.calls[3]).toEqual(
      expect.arrayContaining(["tab", "focus", "w1:t9"]),
    );
    expect(result).toMatchObject({ backend: "herdr" });
  });
});
