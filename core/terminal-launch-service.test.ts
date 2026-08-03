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
  stdout = Object.assign(new EventEmitter(), { unref: vi.fn() });
  stderr = Object.assign(new EventEmitter(), { unref: vi.fn() });
  kill = vi.fn();
  unref = vi.fn();
}

type ScriptedChild = {
  stdout: EventEmitter;
  stderr: EventEmitter;
} & EventEmitter;

let startedHerdrServer: FakeChild | null = null;

const herdr = vi.hoisted(() => ({
  calls: [] as string[][],
  focus: {
    workspaceId: "w9",
    tabId: "w9:t8",
    paneId: "w9:p7",
  },
  // One scripted behavior per expected herdr spawn, consumed in order.
  script: [] as Array<(child: ScriptedChild) => void>,
}));

// Launcher CLI spawns (`lh workflow start --herdr`, #1007): workflow-run launches go through this
// instead of terminal.launch orchestrating herdr tabs/workspaces itself.
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
      if (command === "herdr") {
        const explicitFocus = args.some(
          (arg, index) =>
            arg === "focus" &&
            ["workspace", "tab", "agent", "pane"].includes(
              args[index - 1] ?? "",
            ),
        );
        const implicitFocus =
          !args.includes("--no-focus") &&
          (args.includes("create") ||
            (args.includes("worktree") && args.includes("open")));
        if (explicitFocus || implicitFocus) {
          herdr.focus = {
            workspaceId: "changed",
            tabId: "changed",
            paneId: "changed",
          };
        }
        return scripted(herdr.calls, herdr.script, command, args);
      }
      return actual.spawn(command, args, opts as never);
    },
  };
});

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let db: typeof import("./db.ts").db;
let repoPath: string;
let otherRepoPath: string;

// `herdr workspace create` seeds the new workspace with one tab and one empty pane, reported in
// the same shape `herdr tab create` uses, plus the new workspace itself.
const WORKSPACE_JSON =
  '{"id":"cli:workspace:create","result":{"tab":{"tab_id":"w4:t1","workspace_id":"w4"},"type":"workspace_created","workspace":{"workspace_id":"w4"}}}';
const WORKSPACE_JSON_WITH_ROOT_PANE =
  '{"id":"cli:workspace:create","result":{"root_pane":{"pane_id":"w4:p1"},"tab":{"tab_id":"w4:t1","workspace_id":"w4"},"type":"workspace_created","workspace":{"workspace_id":"w4"}}}';
// The launch's own tab, created inside the resolved workspace. Since herdr 0.7.5 the agent runs in
// a pane that already exists, and only a pane-creating call can carry the launch's `--env`, so this
// is the step that produces the agent's pane in every flow.
const LAUNCH_TAB_JSON =
  '{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"w4:p2"},"tab":{"tab_id":"w4:t2","workspace_id":"w4"},"type":"tab_created"}}';
const WORKSPACE_LIST_EMPTY =
  '{"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[]}}';
const WORKSPACE_LIST_NEW_ISSUE =
  '{"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[{"label":"New Issue","number":4,"workspace_id":"w4"}]}}';
const WORKTREE_OPEN_FRESH_JSON =
  '{"result":{"already_open":false,"workspace":{"workspace_id":"w4"},"tab":{"tab_id":"w4:t1"},"root_pane":{"pane_id":"w4:p1"}}}';
const WORKTREE_OPEN_REUSED_JSON =
  '{"result":{"already_open":true,"workspace":{"workspace_id":"w4"}}}';

// The seeded tab id and the workspace id are parsed independently from the same response — these
// fixtures cover the ways they can disagree (one field present, the other missing/malformed).
// `.result.workspace.workspace_id` is missing, but parseHerdrWorkspaceId falls back to
// `.result.tab.workspace_id`, which is still present — workspaceId still resolves.
const WORKSPACE_JSON_NO_PRIMARY_WORKSPACE_ID =
  '{"id":"cli:workspace:create","result":{"tab":{"tab_id":"w4:t1","workspace_id":"w4"},"type":"workspace_created","workspace":{}}}';
// Neither field carries a usable workspace id — the truly unrecoverable case.
const WORKSPACE_JSON_NO_WORKSPACE_ID_ANYWHERE =
  '{"id":"cli:workspace:create","result":{"tab":{"tab_id":"w4:t1"},"type":"workspace_created","workspace":{}}}';

function exitWith(status: number, stdout?: string) {
  return (child: ScriptedChild) => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", status, null);
  };
}

function startHerdrServer(child: ScriptedChild) {
  startedHerdrServer = child as FakeChild;
  child.stderr.emit(
    "data",
    Buffer.from("herdr server running; you can use any herdr CLI command"),
  );
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
  S = await import("./store.ts");
  ({ db } = await import("./db.ts"));

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

  otherRepoPath = mkdtempSync(join(tmpdir(), "lh-tl-other-repo-"));
  const otherGit = (args: string[]) =>
    spawnSync("git", ["-C", otherRepoPath, ...args], { encoding: "utf8" });
  otherGit(["init", "-q", "-b", "main"]);
  otherGit(["config", "user.email", "t@t.local"]);
  otherGit(["config", "user.name", "tester"]);
  writeFileSync(join(otherRepoPath, "a.txt"), "x\n");
  otherGit(["add", "-A"]);
  otherGit(["commit", "-qm", "init"]);
  await svc.repos.create({ path: otherRepoPath, name: "me/other" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(otherRepoPath, { recursive: true, force: true });
});

beforeEach(() => {
  startedHerdrServer = null;
  herdr.calls.length = 0;
  herdr.script.length = 0;
  herdr.focus = {
    workspaceId: "w9",
    tabId: "w9:t8",
    paneId: "w9:p7",
  };
  lhDev.calls.length = 0;
  lhDev.script.length = 0;
  const timestamp = new Date().toISOString();
  S.upsertWorkerRuntime({
    protocol_version: 1,
    started_at: timestamp,
    heartbeat_at: timestamp,
  });
});

describe("terminal.launch workflow-run spawns `lh workflow start --herdr`", () => {
  test.each([
    ["missing", null],
    [
      "incompatible",
      {
        protocol_version: 2,
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      },
    ],
    [
      "stale",
      {
        protocol_version: 1,
        started_at: "2020-01-01T00:00:00Z",
        heartbeat_at: "2020-01-01T00:00:00Z",
      },
    ],
  ])("rejects a %s worker before spawning the launcher", async (_state, runtime) => {
    db.run("DELETE FROM worker_runtime");
    if (runtime) S.upsertWorkerRuntime(runtime);

    await expect(
      svc.terminal.launch({
        repo: "me/proj",
        workflow: "workflow-run",
        issueNumber: 1,
        workflowId: 9,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(lhDev.calls).toHaveLength(0);
    expect(herdr.calls).toHaveLength(0);
  });

  test("forwards the saved workflow and reports the canonical herdr session", async () => {
    lhDev.script.push(exitWith(0));

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "workflow-run",
      issueNumber: 1,
      workflowId: 9,
    });

    expect(lhDev.calls).toEqual([
      ["lh", "workflow", "start", "me/proj/1", "--workflow-id", "9", "--herdr"],
    ]);
    expect(herdr.calls).toHaveLength(0);
    expect(result).toMatchObject({ backend: "herdr" });
    expect(result.attach).toBe(`herdr session attach ${result.session_name}`);
  });

  test("surfaces a failed CLI launch with the retry command", async () => {
    lhDev.script.push(exitWith(7));

    const err = await svc.terminal
      .launch({
        repo: "me/proj",
        workflow: "workflow-run",
        issueNumber: 1,
        workflowId: 9,
      })
      .then(
        () => null,
        (e: unknown) => e as { message: string; data?: { command?: string } },
      );

    expect(err?.message).toBe("lh workflow start exited with status 7");
    expect(err?.data?.command).toBe(
      "lh workflow start me/proj/1 --workflow-id 9 --herdr",
    );
  });

  test("requires issueNumber and workflowId", async () => {
    await expect(
      svc.terminal.launch({
        repo: "me/proj",
        workflow: "workflow-run",
        issueNumber: 1,
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      svc.terminal.launch({
        repo: "me/proj",
        workflow: "workflow-run",
        workflowId: 9,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(lhDev.calls).toHaveLength(0);
  });

  test("reports lh missing from PATH distinctly from a launch failure", async () => {
    lhDev.script.push((child) =>
      child.emit(
        "error",
        Object.assign(new Error("spawn lh ENOENT"), { code: "ENOENT" }),
      ),
    );

    const err = await svc.terminal
      .launch({
        repo: "me/proj",
        workflow: "workflow-run",
        issueNumber: 1,
        workflowId: 9,
      })
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
      .launch({
        repo: "me/proj",
        workflow: "workflow-run",
        issueNumber: 1,
        workflowId: 9,
      })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    // The client-facing message stays generic — raw launcher stderr can embed the server's
    // absolute paths or a stack trace, so it must never reach the RPC caller.
    expect(err?.message).toBe("lh workflow start exited with status 1");
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
      .launch({
        repo: "me/proj",
        workflow: "workflow-run",
        issueNumber: 1,
        workflowId: 9,
      })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    expect(err?.message).toBe(
      "lh workflow start was terminated by signal SIGKILL",
    );
  });

  test("times out and kills the child if the launcher hangs, logging any stderr it printed before wedging", async () => {
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
        workflow: "workflow-run",
        issueNumber: 1,
        workflowId: 9,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        message: expect.stringMatching(
          /^lh workflow start timed out after \d+ms$/,
        ),
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

describe("terminal.launch workflow-create (global New workflow, #1889)", () => {
  test("opens a fresh workspace without requiring worker compatibility or a repo", async () => {
    db.run("DELETE FROM worker_runtime");
    herdr.script.push(
      exitWith(0, WORKSPACE_JSON_WITH_ROOT_PANE), // workspace create
      exitWith(0, LAUNCH_TAB_JSON), // the launch's own tab (carries --env)
      exitWith(0), // pane rename
      exitWith(0, '{"result":{"agent":{"pane_id":"w4:p2"}}}'), // agent start
      exitWith(0), // prompt paste
      exitWith(0), // prompt submit
      exitWith(0), // seeded tab close
    );

    const result = await svc.terminal.launch({
      workflow: "workflow-create",
      label: "New workflow",
      prompt: "Create a workflow, then stop.",
    });

    // No workspace list/probe: workflow-create goes straight to a fresh workspace.
    expect(herdr.calls[0]).toContain("workspace");
    expect(herdr.calls[0]).toContain("create");
    const tabCreate = herdr.calls[1];
    expect(tabCreate).toEqual(
      expect.arrayContaining(["tab", "create", "--workspace", "w4"]),
    );
    // The agent runs from LoopHub home (the isolated LOOPHUB_HOME), not a repo checkout.
    expect(tabCreate[tabCreate.indexOf("--cwd") + 1]).toBe(HOME);
    const agentStart = herdr.calls[3];
    expect(agentStart).toContain("start");
    expect(agentStart[agentStart.indexOf("--pane") + 1]).toBe("w4:p2");
    expect(agentStart[agentStart.indexOf("--kind") + 1]).toBe("claude");
    expect(agentStart.slice(agentStart.indexOf("--") + 1)).toEqual([
      "--permission-mode",
      "auto",
    ]);
    // The workflow-create instructions are delivered into the agent, not put on its command line.
    expect(herdr.calls[4]).toContain("send-text");
    expect(herdr.calls[4][herdr.calls[4].length - 1]).toContain(
      "Create a workflow, then stop.",
    );
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(7));
    expect(
      herdr.calls.some(
        (call) => call.includes("focus") && call.includes("workspace"),
      ),
    ).toBe(false);
    expect(
      herdr.calls.some(
        (call) => call.includes("focus") && call.includes("tab"),
      ),
    ).toBe(false);
    expect(result).toMatchObject({ backend: "herdr" });
  });

  test("requires a prompt", async () => {
    await expect(
      svc.terminal.launch({
        workflow: "workflow-create",
        label: "New workflow",
      }),
    ).rejects.toThrow(/prompt is required/u);
  });
});

describe("terminal.launch github-pr-export focus preservation", () => {
  function createPull(): number {
    const repo = S.getRepo("me", "proj");
    if (!repo) throw new Error("repo missing");
    const pull = S.createIssue(repo.id, "pull", "Export to GitHub", "", "me");
    S.createPull(pull.id, `loophub/pr-${pull.number}`, "main", null);
    return pull.number;
  }

  test.each([
    ["fresh workspace", 0, WORKTREE_OPEN_FRESH_JSON, true, true],
    ["reused workspace", 0, WORKTREE_OPEN_REUSED_JSON, true, false],
    ["repo-root fallback tab", 1, undefined, false, false],
  ] as const)("preserves the existing focus through a %s launch", async (_placement, openStatus, openStdout, scopedTab, closesSeedTab) => {
    const pullNumber = createPull();
    const focusBefore = { ...herdr.focus };
    herdr.script.push(
      exitWith(openStatus, openStdout), // worktree open
      exitWith(0, LAUNCH_TAB_JSON), // launch tab
      exitWith(0), // pane rename
      exitWith(0, '{"result":{"agent":{"pane_id":"w4:p2"}}}'),
      exitWith(0), // prompt paste
      exitWith(0), // prompt submit
    );
    if (closesSeedTab) herdr.script.push(exitWith(0));

    await expect(
      svc.terminal.launch({
        repo: "me/proj",
        workflow: "github-pr-export",
        prNumber: pullNumber,
        label: "Create PR on GitHub",
        prompt: "Create the pull request.",
      }),
    ).resolves.toMatchObject({ backend: "herdr" });

    const worktreeOpen = herdr.calls[0];
    expect(worktreeOpen).toEqual(
      expect.arrayContaining(["worktree", "open", "--no-focus"]),
    );
    const tabCreate = herdr.calls[1];
    expect(tabCreate).toEqual(
      expect.arrayContaining(["tab", "create", "--no-focus"]),
    );
    if (scopedTab) {
      expect(tabCreate).toEqual(expect.arrayContaining(["--workspace", "w4"]));
    } else {
      expect(tabCreate).not.toContain("--workspace");
    }
    if (closesSeedTab) {
      await vi.waitFor(() => expect(herdr.calls).toHaveLength(7));
      expect(herdr.calls[6]).toEqual(
        expect.arrayContaining(["tab", "close", "w4:t1"]),
      );
    }
    expect(
      herdr.calls.some((call) =>
        call.some(
          (arg, index) =>
            arg === "focus" &&
            ["workspace", "tab", "agent", "pane"].includes(
              call[index - 1] ?? "",
            ),
        ),
      ),
    ).toBe(false);
    expect(herdr.focus).toEqual(focusBefore);
  });
});

describe("terminal.launch dedicated workspace orchestration for New Issue", () => {
  test("creates the dedicated workspace without requiring worker compatibility", async () => {
    db.run("DELETE FROM worker_runtime");
    herdr.script.push(
      exitWith(1),
      exitWith(0, '{"sessions":[]}'),
      startHerdrServer,
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      exitWith(0),
      exitWith(0),
      exitWith(0),
      exitWith(0),
    );

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue first session",
    });

    expect(herdr.calls[0]).toEqual(
      expect.arrayContaining(["workspace", "list"]),
    );
    expect(herdr.calls[1]).toEqual(["herdr", "session", "list", "--json"]);
    expect(herdr.calls[2]).toEqual([
      "herdr",
      "--session",
      herdr.calls[0][2],
      "server",
    ]);
    expect(herdr.calls[3]).toEqual(
      expect.arrayContaining(["workspace", "create", "--label", "New Issue"]),
    );
    expect(herdr.calls[4]).toEqual(
      expect.arrayContaining(["tab", "create", "--workspace", "w4"]),
    );
    // `lh issue new` is not a runtime binary, so it is typed into the pane rather than started
    // through `agent start --kind`.
    expect(herdr.calls[6]).toEqual(
      expect.arrayContaining(["pane", "send-text", "w4:p2"]),
    );
    expect(startedHerdrServer?.stdout.listenerCount("data")).toBe(1);
    expect(startedHerdrServer?.stderr.listenerCount("data")).toBe(1);
    expect(startedHerdrServer?.stdout.unref).toHaveBeenCalledOnce();
    expect(startedHerdrServer?.stderr.unref).toHaveBeenCalledOnce();
    expect(startedHerdrServer?.unref).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ backend: "herdr" });
  });

  test("creates one dedicated workspace and reuses it for later New Issue tabs", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      ...Array.from({ length: 4 }, () => exitWith(0)),
      exitWith(0, WORKSPACE_LIST_NEW_ISSUE),
      exitWith(0, LAUNCH_TAB_JSON.replaceAll("t2", "t3")),
      ...Array.from({ length: 3 }, () => exitWith(0)),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue 1",
    });
    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue 2",
    });

    expect(
      herdr.calls.filter(
        (call) => call.includes("workspace") && call.includes("create"),
      ),
    ).toHaveLength(1);
    expect(herdr.calls[1]).toEqual(
      expect.arrayContaining(["workspace", "create", "--label", "New Issue"]),
    );
    // The reused workspace gets the launch's own tab; no second workspace is created.
    expect(herdr.calls[8]).toEqual(
      expect.arrayContaining(["tab", "create", "--workspace", "w4"]),
    );
    expect(herdr.calls[10]).toEqual(
      expect.arrayContaining(["pane", "send-text", "w4:p2"]),
    );
  });

  test("serializes simultaneous New Issue launches into one dedicated workspace", async () => {
    const repo = S.getRepo("me", "proj");
    if (!repo) throw new Error("repo missing");
    const existingPaneIds = new Set(
      S.listIssueHerdrPanes(repo.id).map((pane) => pane.id),
    );
    let responseIndex = 0;
    let workspaceCreated = false;
    let missingSessionReported = false;
    const respondByCommand = (child: ScriptedChild) => {
      const call = herdr.calls[responseIndex++];
      if (call.includes("workspace") && call.includes("list")) {
        if (!workspaceCreated && !missingSessionReported) {
          missingSessionReported = true;
          exitWith(1)(child);
          return;
        }
        exitWith(
          0,
          workspaceCreated ? WORKSPACE_LIST_NEW_ISSUE : WORKSPACE_LIST_EMPTY,
        )(child);
        return;
      }
      if (call[1] === "session" && call.includes("list")) {
        exitWith(0, '{"sessions":[]}')(child);
        return;
      }
      if (call.includes("server")) {
        startHerdrServer(child);
        return;
      }
      if (call.includes("workspace") && call.includes("create")) {
        workspaceCreated = true;
        exitWith(0, WORKSPACE_JSON)(child);
        return;
      }
      if (call.includes("tab") && call.includes("create")) {
        exitWith(
          0,
          LAUNCH_TAB_JSON.replaceAll("w4:p2", `w4:p${responseIndex}`),
        )(child);
        return;
      }
      exitWith(0)(child);
    };
    herdr.script.push(...Array.from({ length: 20 }, () => respondByCommand));

    await Promise.all([
      svc.terminal.launch({
        repo: "me/proj",
        workflow: "issue-create",
        label: "New issue concurrent 1",
      }),
      svc.terminal.launch({
        repo: "me/proj",
        workflow: "issue-create",
        label: "New issue concurrent 2",
      }),
    ]);

    expect(
      herdr.calls.filter(
        (call) => call.includes("workspace") && call.includes("create"),
      ),
    ).toHaveLength(1);
    expect(herdr.calls.filter((call) => call.includes("server"))).toHaveLength(
      1,
    );
    // Each launch creates its own tab in the shared workspace and types its command into that
    // tab's pane.
    const tabs = herdr.calls.filter(
      (call) => call.includes("tab") && call.includes("create"),
    );
    expect(tabs).toHaveLength(2);
    expect(tabs.every((call) => call.includes("--workspace"))).toBe(true);
    const sends = herdr.calls.filter((call) => call.includes("send-text"));
    expect(sends).toHaveLength(2);
    const registered = S.listIssueHerdrPanes(repo.id).filter(
      (pane) => !existingPaneIds.has(pane.id),
    );
    expect(registered).toHaveLength(2);
    expect(new Set(registered.map((pane) => pane.pane_id)).size).toBe(2);
  });

  test("surfaces workspace-list failures without creating a duplicate workspace", async () => {
    herdr.script.push(exitWith(3), exitWith(0, "not json"));

    const nonZero = await svc.terminal
      .launch({
        repo: "me/proj",
        workflow: "issue-create",
        label: "New issue list failure",
      })
      .then(
        () => null,
        (error: unknown) =>
          error as { message: string; data?: { command?: string } },
      );
    const malformed = await svc.terminal
      .launch({
        repo: "me/proj",
        workflow: "issue-create",
        label: "New issue malformed list",
      })
      .then(
        () => null,
        (error: unknown) =>
          error as { message: string; data?: { command?: string } },
      );

    expect(nonZero?.message).toBe("Herdr exited with status 3");
    expect(nonZero?.data?.command).toContain("workspace list");
    expect(malformed?.message).toBe(
      "Herdr workspace list returned an invalid response",
    );
    expect(herdr.calls).toHaveLength(2);
    expect(
      herdr.calls.some(
        (call) => call.includes("workspace") && call.includes("create"),
      ),
    ).toBe(false);
  });

  test("keeps exit-1 workspace-list failures visible when the repo session is running", async () => {
    herdr.script.push(exitWith(1), (child) => {
      const sessionName = herdr.calls[0][2];
      exitWith(
        0,
        JSON.stringify({
          sessions: [{ name: sessionName, running: true }],
        }),
      )(child);
    });

    const err = await svc.terminal
      .launch({
        repo: "me/proj",
        workflow: "issue-create",
        label: "New issue running-session list failure",
      })
      .then(
        () => null,
        (error: unknown) =>
          error as { message: string; data?: { command?: string } },
      );

    expect(err?.message).toBe("Herdr exited with status 1");
    expect(err?.data?.command).toContain("workspace list");
    expect(herdr.calls).toHaveLength(2);
    expect(
      herdr.calls.some(
        (call) => call.includes("workspace") && call.includes("create"),
      ),
    ).toBe(false);
  });

  test("keeps the dedicated workspace and surfaces the existing error when a reused-tab launch fails", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_NEW_ISSUE),
      exitWith(0, LAUNCH_TAB_JSON),
      exitWith(0), // pane rename
      exitWith(3), // send-text fails
      exitWith(0), // tab close
    );

    const err = await svc.terminal
      .launch({
        repo: "me/proj",
        workflow: "issue-create",
        label: "New issue failed reuse",
      })
      .then(
        () => null,
        (error: unknown) =>
          error as { message: string; data?: { command?: string } },
      );

    expect(err?.message).toBe("Herdr could not start the agent");
    expect(err?.data?.command).toContain("tab create");
    expect(err?.data?.command).toContain("lh issue new --repo");
    // Only the tab this launch added is dropped; the shared New Issue workspace stays.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(5));
    expect(herdr.calls[4]).toEqual(
      expect.arrayContaining(["tab", "close", "w4:t2"]),
    );
    expect(herdr.calls[4]).not.toContain("workspace");
  });

  test("separates New Issue workspaces for different repositories", async () => {
    let responseIndex = 0;
    const respondByCommand = (child: ScriptedChild) => {
      const call = herdr.calls[responseIndex++];
      if (call.includes("workspace") && call.includes("list")) {
        exitWith(0, WORKSPACE_LIST_EMPTY)(child);
        return;
      }
      if (call.includes("workspace") && call.includes("create")) {
        exitWith(0, WORKSPACE_JSON)(child);
        return;
      }
      if (call.includes("tab") && call.includes("create")) {
        exitWith(
          0,
          LAUNCH_TAB_JSON.replaceAll("w4:p2", `w4:p${responseIndex}`),
        )(child);
        return;
      }
      exitWith(0)(child);
    };
    herdr.script.push(...Array.from({ length: 20 }, () => respondByCommand));

    await Promise.all([
      svc.terminal.launch({
        repo: "me/proj",
        workflow: "issue-create",
        label: "New issue proj",
      }),
      svc.terminal.launch({
        repo: "me/other",
        workflow: "issue-create",
        label: "New issue other",
      }),
    ]);

    const creates = herdr.calls.filter(
      (call) => call.includes("workspace") && call.includes("create"),
    );
    expect(creates).toHaveLength(2);
    expect(
      new Set(creates.map((call) => call[call.indexOf("--session") + 1])).size,
    ).toBe(2);
  });

  test("creates a new workspace (not a tab in the existing session) and starts the agent in it", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      ...Array.from({ length: 4 }, () => exitWith(0)),
    );

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    expect(herdr.calls[0]).toContain("workspace");
    expect(herdr.calls[0]).toContain("list");
    expect(herdr.calls[1]).toContain("workspace");
    expect(herdr.calls[1]).toContain("create");
    expect(herdr.calls[1]).not.toContain("tab");
    const tabCreate = herdr.calls[2];
    expect(tabCreate).toEqual(
      expect.arrayContaining(["tab", "create", "--workspace", "w4"]),
    );
    expect(result).toMatchObject({ backend: "herdr" });
  });

  test("closes a claimless pane when registration arrives after its Issue closed", async () => {
    const repo = S.getRepo("me", "proj");
    if (!repo) throw new Error("repo missing");
    let launchId = "";
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      exitWith(0), // pane rename
      async (child) => {
        const command = herdr.calls[4].join(" ");
        launchId = command.match(
          /LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH='([^']+)'/u,
        )?.[1] as string;
        const issue = S.createIssue(
          repo.id,
          "issue",
          "closed before registration",
          "",
          "me",
        );
        S.upsertIssueHerdrPane({
          launchId,
          repoId: repo.id,
          issueId: issue.id,
        });
        S.updateIssue(issue.id, { state: "closed" });
        await svc.terminal.cleanupClosedIssuePanes({
          repo: repo.full_name,
          issueNumber: issue.number,
        });
        child.emit("close", 0, null);
      },
      exitWith(
        0,
        '{"result":{"process_info":{"foreground_process_group_id":999997}}}',
      ),
      exitWith(0),
      exitWith(0),
    );

    try {
      await svc.terminal.launch({
        repo: repo.full_name,
        workflow: "issue-create",
        label: "New issue",
      });

      expect(launchId).not.toBe("");
      await vi.waitFor(() =>
        expect(
          S.getHerdrPaneByLaunch(repo.id, launchId)?.closed_at,
        ).not.toBeNull(),
      );
      expect(
        herdr.calls.some(
          (call) => call.includes("close") && call.includes("w4:p2"),
        ),
      ).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  test("does not kill or close a pane that gains a claim during the close check", async () => {
    const repo = S.getRepo("me", "proj");
    if (!repo) throw new Error("repo missing");
    let launchId = "";
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      exitWith(0), // pane rename
      async (child) => {
        const command = herdr.calls[4].join(" ");
        launchId = command.match(
          /LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH='([^']+)'/u,
        )?.[1] as string;
        const issue = S.createIssue(
          repo.id,
          "issue",
          "claim races close",
          "",
          "me",
        );
        S.upsertIssueHerdrPane({
          launchId,
          repoId: repo.id,
          issueId: issue.id,
        });
        S.updateIssue(issue.id, { state: "closed" });
        await svc.terminal.cleanupClosedIssuePanes({
          repo: repo.full_name,
          issueNumber: issue.number,
        });
        child.stdout.emit(
          "data",
          Buffer.from('{"result":{"agent":{"pane_id":"w4:p10"}}}'),
        );
        child.emit("close", 0, null);
      },
      (child) => {
        S.addHerdrPaneClaim({
          repoId: repo.id,
          launchId,
          resourceKind: "workflow_run",
          resourceKey: "race-claim",
          purpose: "workflow-lifecycle",
        });
        child.stdout.emit(
          "data",
          Buffer.from(
            '{"result":{"process_info":{"foreground_process_group_id":999996}}}',
          ),
        );
        child.emit("close", 0, null);
      },
      exitWith(0),
    );

    try {
      await svc.terminal.launch({
        repo: repo.full_name,
        workflow: "issue-create",
        label: "New issue",
      });

      await vi.waitFor(() => expect(herdr.calls).toHaveLength(8));
      expect(killSpy).not.toHaveBeenCalled();
      expect(S.getHerdrPaneByLaunch(repo.id, launchId)?.closed_at).toBeNull();
      expect(
        herdr.calls.some(
          (call) => call.includes("close") && call.includes("w4:p10"),
        ),
      ).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  test("forwards the one-shot New Issue runtime and model to the Herdr command", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      ...Array.from({ length: 4 }, () => exitWith(0)),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    });

    expect(herdr.calls[4]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "lh issue new --repo 'me/proj' --codex --model 'gpt-5.6-sol' --effort 'high'",
        ),
      ]),
    );
  });

  test("forwards the workspace target branch to the Herdr command", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      ...Array.from({ length: 4 }, () => exitWith(0)),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New workspace issue",
      targetBranch: "workspace/alpha",
    });

    expect(herdr.calls[4]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "lh issue new --repo 'me/proj' --target-branch 'workspace/alpha'",
        ),
      ]),
    );
  });

  // Once the agent is running in the new workspace, herdr's active workspace should switch to
  // it automatically (#556) rather than leaving it selectable only by hand.
  test("focuses the newly created workspace once the agent has started (#556)", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      ...Array.from({ length: 4 }, () => exitWith(0)),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    // Fire-and-forget: wait for the queued seed-tab close and focus spawns to happen.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(7));
    const focus = herdr.calls[6];
    expect(focus).toContain("workspace");
    expect(focus).toContain("focus");
    expect(focus).toContain("w4");
  });

  test("keeps the shared workspace and closes only its own tab when the first agent fails", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON),
      exitWith(0, LAUNCH_TAB_JSON),
      exitWith(0), // pane rename
      exitWith(3), // send-text fails
      exitWith(0), // tab close
    );

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-create", label: "New issue" })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    expect(err?.message).toBe("Herdr could not start the agent");
    // Fire-and-forget cleanup: the shared workspace persists for the next New Issue launch.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(6));
    const cleanup = herdr.calls[5];
    expect(cleanup).toContain("tab");
    expect(cleanup).toContain("close");
    expect(cleanup).toContain("w4:t2");
    expect(cleanup).not.toContain("workspace");
  });

  // The launch cannot start its agent in the tab a `workspace create` seeds: that tab was created
  // without the launch's `--env`, and `agent start` carries no environment of its own. So the
  // launch adds its own tab and the seeded one is dropped once the real one exists.
  test("closes the workspace's seeded tab after the first New Issue agent starts", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON_WITH_ROOT_PANE),
      exitWith(0, LAUNCH_TAB_JSON),
      ...Array.from({ length: 4 }, () => exitWith(0)),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    await vi.waitFor(() => expect(herdr.calls).toHaveLength(7));
    const cleanup = herdr.calls[5];
    expect(cleanup).toEqual(expect.arrayContaining(["tab", "close", "w4:t1"]));
    expect(cleanup).not.toContain("w4:t2");
    const focus = herdr.calls[6];
    expect(focus).toContain("workspace");
    expect(focus).toContain("focus");
  });

  test("touches no existing tab when reusing the New Issue workspace", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_NEW_ISSUE),
      exitWith(0, LAUNCH_TAB_JSON),
      ...Array.from({ length: 3 }, () => exitWith(0)),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    await vi.waitFor(() => expect(herdr.calls).toHaveLength(5));
    // A reused workspace has no seeded tab of this launch's making, so nothing is closed — only
    // the launch's own new tab is brought forward.
    expect(herdr.calls.some((call) => call.includes("close"))).toBe(false);
    const focus = herdr.calls[4];
    expect(focus).toEqual(expect.arrayContaining(["tab", "focus", "w4:t2"]));
  });

  test("does not wait for New Issue seeded-tab cleanup to finish", async () => {
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON_WITH_ROOT_PANE),
      exitWith(0, LAUNCH_TAB_JSON),
      exitWith(0),
      exitWith(0),
      exitWith(0),
      () => {},
      () => {},
    );

    await expect(
      svc.terminal.launch({
        repo: "me/proj",
        workflow: "issue-create",
        label: "New issue",
      }),
    ).resolves.toMatchObject({ backend: "herdr" });

    await vi.waitFor(() => expect(herdr.calls).toHaveLength(7));
    expect(herdr.calls[5]).toEqual(
      expect.arrayContaining(["tab", "close", "w4:t1"]),
    );
  });

  // The workspace id is what makes a created workspace both targetable and closeable, and it is
  // parsed independently of the seeded tab id out of the same `herdr workspace create` response.
  test("falls back to a plain tab when the created workspace has no usable id", async () => {
    // Without an id the workspace can neither be placed into nor cleaned up, so the launch must
    // not adopt it: it creates an unscoped tab instead of leaving a second orphan behind.
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON_NO_WORKSPACE_ID_ANYWHERE),
      exitWith(0, LAUNCH_TAB_JSON),
      ...Array.from({ length: 4 }, () => exitWith(0)),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-create",
      label: "New issue",
    });

    const tabCreate = herdr.calls[2];
    expect(tabCreate).toEqual(expect.arrayContaining(["tab", "create"]));
    expect(tabCreate).not.toContain("--workspace");
  });

  test("still preserves the shared workspace when its id is recovered from the seeded tab", async () => {
    // `.result.workspace.workspace_id` is missing, but `.result.tab.workspace_id` carries the
    // same id — parseHerdrWorkspaceId falls back to it for placement and focus, while failed New
    // Issue launch cleanup still targets only this launch's tab because the workspace is shared.
    herdr.script.push(
      exitWith(0, WORKSPACE_LIST_EMPTY),
      exitWith(0, WORKSPACE_JSON_NO_PRIMARY_WORKSPACE_ID),
      exitWith(0, LAUNCH_TAB_JSON),
      exitWith(0),
      exitWith(3),
      exitWith(0),
    );

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-create", label: "New issue" })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    expect(err?.message).toBe("Herdr could not start the agent");
    expect(herdr.calls[2]).toEqual(
      expect.arrayContaining(["tab", "create", "--workspace", "w4"]),
    );
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(6));
    const cleanup = herdr.calls[5];
    expect(cleanup).toContain("tab");
    expect(cleanup).toContain("close");
    expect(cleanup).toContain("w4:t2");
    expect(cleanup).not.toContain("workspace");
  });
});
