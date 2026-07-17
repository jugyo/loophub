import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Isolate the log directory before importing the logger (LOGS_DIR is resolved at import time).
const dir = mkdtempSync(join(tmpdir(), "lh-web-action-log-"));
process.env.LOOPHUB_WEB_LOG_DIR = dir;

let A: typeof import("./action-log.ts");
beforeAll(async () => {
  A = await import("./action-log.ts");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The action log routes through log.info, which console.log's to stdout.
function stdout() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("logHumanAction", () => {
  it("logs a launch with workflow, repo, issue, and pr identifiers", () => {
    const out = stdout();
    A.logHumanAction("terminal/launch", {
      repo: "o/r",
      workflow: "workflow-run",
      issueNumber: 12,
      prNumber: 34,
    });
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0][0]).toMatch(
      /INFO human action: launch workflow=workflow-run repo=o\/r issue=#12 pr=#34$/,
    );
  });

  it("omits absent optional identifiers", () => {
    const out = stdout();
    A.logHumanAction("terminal/launch", { repo: "o/r", workflow: "resume" });
    expect(out.mock.calls[0][0]).toMatch(
      /INFO human action: launch workflow=resume repo=o\/r$/,
    );
  });

  it("logs a killed herdr agent with its pane id", () => {
    const out = stdout();
    A.logHumanAction("terminal/killAgent", { repo: "o/r", paneId: "wQC:pH" });
    expect(out.mock.calls[0][0]).toMatch(
      /INFO human action: kill agent repo=o\/r pane=wQC:pH$/,
    );
  });

  it("logs injected input with repo, pr, and pane", () => {
    const out = stdout();
    A.logHumanAction("terminal/sendAgentInput", {
      repo: "o/r",
      pull: 34,
      paneId: "wQC:pH",
      text: "hi",
    });
    expect(out.mock.calls[0][0]).toMatch(
      /INFO human action: inject input repo=o\/r pr=#34 pane=wQC:pH$/,
    );
  });

  it("logs a merge with method, defaulting to squash", () => {
    const out = stdout();
    A.logHumanAction("pulls/merge", { repo: "o/r", number: 34 });
    expect(out.mock.calls[0][0]).toMatch(
      /INFO human action: merge pr repo=o\/r pr=#34 method=squash$/,
    );
    A.logHumanAction("pulls/merge", {
      repo: "o/r",
      number: 34,
      merge_method: "rebase",
    });
    expect(out.mock.calls[1][0]).toMatch(/method=rebase$/);
  });

  it("does not log non-whitelisted methods (queries, sweeps)", () => {
    const out = stdout();
    A.logHumanAction("terminal/sessions", {});
    A.logHumanAction("pulls/list", { repo: "o/r" });
    A.logHumanAction("terminal/focusAgent", { repo: "o/r", paneId: "x" });
    expect(out).not.toHaveBeenCalled();
  });
});
