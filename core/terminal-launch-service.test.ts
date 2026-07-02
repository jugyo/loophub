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
  kill = vi.fn();
}

const herdr = vi.hoisted(() => ({
  calls: [] as string[][],
  // One scripted behavior per expected herdr spawn, consumed in order.
  script: [] as Array<(child: { stdout: EventEmitter } & EventEmitter) => void>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], opts: object) => {
      if (command !== "herdr")
        return actual.spawn(command, args, opts as never);
      herdr.calls.push([command, ...args]);
      const behavior = herdr.script.shift();
      const child = new FakeChild();
      queueMicrotask(() => {
        if (behavior) behavior(child);
        else child.emit("close", 0, null);
      });
      return child;
    },
  };
});

let svc: typeof import("./service.ts");
let repoPath: string;

const TAB_JSON =
  '{"id":"cli:tab:create","result":{"tab":{"tab_id":"w1:t9","workspace_id":"w1"},"type":"tab_created"}}';

// Real `herdr tab create` output also reports the tab's seeded empty pane as `root_pane`.
const TAB_JSON_WITH_ROOT_PANE =
  '{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"w1:p1Q"},"tab":{"tab_id":"w1:t9","workspace_id":"w1"},"type":"tab_created"}}';

function exitWith(status: number, stdout?: string) {
  return (child: { stdout: EventEmitter } & EventEmitter) => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", status, null);
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
  svc.settings.update({ terminalLaunchBackend: "herdr" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

beforeEach(() => {
  herdr.calls.length = 0;
  herdr.script.length = 0;
});

describe("terminal.launch tab orchestration", () => {
  test("creates a tab and starts the agent in it", async () => {
    herdr.script.push(exitWith(0, TAB_JSON), exitWith(0));

    const result = await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
    });

    expect(herdr.calls).toHaveLength(2);
    expect(herdr.calls[0]).toContain("tab");
    expect(herdr.calls[0]).toContain("create");
    const agentStart = herdr.calls[1];
    expect(agentStart).toContain("start");
    expect(agentStart[agentStart.indexOf("--tab") + 1]).toBe("w1:t9");
    expect(result).toMatchObject({ backend: "herdr" });
  });

  // `herdr tab create` seeds the new tab with one empty default pane; `agent start --tab`
  // splits alongside it rather than replacing it, leaving it behind unless closed (#503).
  test("closes the tab's leftover empty pane once the agent has started in it", async () => {
    herdr.script.push(
      exitWith(0, TAB_JSON_WITH_ROOT_PANE),
      exitWith(0),
      exitWith(0),
    );

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
    });

    // Fire-and-forget cleanup: wait for the queued pane-close spawn to happen.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(3));
    const paneClose = herdr.calls[2];
    expect(paneClose).toContain("pane");
    expect(paneClose).toContain("close");
    expect(paneClose).toContain("w1:p1Q");
  });

  test("skips the pane close when tab create output has no root pane id", async () => {
    herdr.script.push(exitWith(0, TAB_JSON), exitWith(0));

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
    });

    expect(herdr.calls).toHaveLength(2);
  });

  test("falls back to a tab-less launch when tab creation fails", async () => {
    herdr.script.push(exitWith(1), exitWith(0));

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
    });

    expect(herdr.calls).toHaveLength(2);
    expect(herdr.calls[1]).not.toContain("--tab");
  });

  test("closes the created tab and suggests a tab-less command when agent start fails", async () => {
    herdr.script.push(exitWith(0, TAB_JSON), exitWith(3), exitWith(0));

    const err = await svc.terminal
      .launch({ repo: "me/proj", workflow: "issue-dev", issueNumber: 1 })
      .then(
        () => null,
        (e: unknown) => e as { message: string; data?: { command?: string } },
      );

    expect(err?.message).toBe("Herdr exited with status 3");
    expect(err?.data?.command).not.toContain("--tab");
    // Fire-and-forget cleanup: wait for the queued tab-close spawn to happen.
    await vi.waitFor(() => expect(herdr.calls).toHaveLength(3));
    const tabClose = herdr.calls[2];
    expect(tabClose).toContain("close");
    expect(tabClose).toContain("w1:t9");
  });

  test("appends --auto to the launched command when autoModeOnBuild is enabled (#499)", async () => {
    herdr.script.push(exitWith(0, TAB_JSON), exitWith(0));
    svc.settings.update({ autoModeOnBuild: true });

    await svc.terminal.launch({
      repo: "me/proj",
      workflow: "issue-dev",
      issueNumber: 1,
    });

    const agentStart = herdr.calls[1];
    expect(agentStart[agentStart.length - 1]).toContain("--auto");

    svc.settings.update({ autoModeOnBuild: false });
  });
});
