import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Isolate the DB before contract.ts -> service.ts -> db.ts runs its import-time setup.
const HOME = mkdtempSync(join(tmpdir(), "lh-rpc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let dispatch: typeof import("./rpc.ts").dispatch;
let dispatchRaw: typeof import("./rpc.ts").dispatchRaw;
let ERROR_CODES: typeof import("./rpc.ts").ERROR_CODES;
let MAX_RPC_BATCH_SIZE: typeof import("./rpc.ts").MAX_RPC_BATCH_SIZE;
let db: typeof import("../../core/db.ts").db;
let svc: typeof import("../../core/service.ts");
let S: typeof import("../../core/store.ts");
let ServiceError: typeof import("../../core/errors.ts").ServiceError;
let setWebRuntimeConfig: typeof import("./runtime-config.ts").setWebRuntimeConfig;
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function call(method: string, params?: any, id: any = 1) {
  return dispatch({ jsonrpc: "2.0", id, method, params });
}

beforeAll(async () => {
  ({ dispatch, dispatchRaw, ERROR_CODES, MAX_RPC_BATCH_SIZE } = await import(
    "./rpc.ts"
  ));
  ({ db } = await import("../../core/db.ts"));
  svc = await import("../../core/service.ts");
  S = await import("../../core/store.ts");
  ({ ServiceError } = await import("../../core/errors.ts"));
  ({ setWebRuntimeConfig } = await import("./runtime-config.ts"));

  repoPath = mkdtempSync(join(tmpdir(), "lh-rpc-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["branch", "integration/stack"]);

  const r: any = await call("repos/create", {
    path: repoPath,
    name: "me/proj",
  });
  expect(r.result.full_name).toBe("me/proj");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("initialize returns capabilities with the method list", async () => {
  setWebRuntimeConfig({ debug: false });
  const r: any = await call("initialize", {});
  expect(r.result.protocolVersion).toBeTypeOf("string");
  expect(r.result.serverInfo.name).toBe("loophub");
  expect(r.result.capabilities.methods).toContain("issues/create");
  expect(r.result.capabilities.methods).not.toContain("scheduledTasks/run");
  expect(r.result.capabilities.notifications).toEqual([]);
  expect(r.result.webConfig).toEqual({ debug: false });
});

test("initialize exposes enabled Web UI debug controls", async () => {
  setWebRuntimeConfig({ debug: true });
  const r: any = await call("initialize", {});
  expect(r.result.webConfig).toEqual({ debug: true });
  setWebRuntimeConfig({ debug: false });
});

test("a known method routes to the service and returns a result", async () => {
  const created: any = await call("issues/create", {
    repo: "me/proj",
    title: "hello",
    body: "b",
  });
  expect(created.result.number).toBe(1);
  const got: any = await call("issues/get", { repo: "me/proj", number: 1 });
  expect(got.result.title).toBe("hello");
});

test("acceptance criteria authoring routes through issue domain procedures", async () => {
  const added: any = await call("issues/ac/add", {
    repo: "me/proj",
    number: 1,
    text: "  remains stable  ",
  });
  expect(added.result).toMatchObject({
    number: 1,
    text: "remains stable",
    enabled: true,
  });

  const disabled: any = await call("issues/ac/setEnabled", {
    repo: "me/proj",
    number: 1,
    criterion_id: added.result.id,
    enabled: false,
  });
  expect(disabled.result).toMatchObject({
    id: added.result.id,
    number: 1,
    enabled: false,
  });
  const issue: any = await call("issues/get", {
    repo: "me/proj",
    number: 1,
  });
  expect(issue.result.acceptance_criteria).toEqual([]);

  const all: any = await call("issues/ac/list", {
    repo: "me/proj",
    number: 1,
  });
  expect(all.result).toEqual([disabled.result]);

  const restored: any = await call("issues/ac/setEnabled", {
    repo: "me/proj",
    number: 1,
    criterion_id: added.result.id,
    enabled: true,
  });
  expect(restored.result).toMatchObject({
    id: added.result.id,
    number: 1,
    enabled: true,
  });
});

test("worker status is exposed and an unconfirmed worker blocks only workflow launch", async () => {
  db.run("DELETE FROM worker_runtime");
  const before = {
    pulls: (db.query("SELECT count(*) AS count FROM pulls").get() as any).count,
    runs: (db.query("SELECT count(*) AS count FROM workflow_runs").get() as any)
      .count,
    sessions: (
      db.query("SELECT count(*) AS count FROM agent_sessions").get() as any
    ).count,
  };

  const status: any = await call("worker/status", {});
  expect(status.result).toMatchObject({
    status: "missing",
    required_protocol_version: 1,
    observed_protocol_version: null,
  });

  const launch: any = await call("terminal/launch", {
    repo: "me/proj",
    workflow: "workflow-run",
    issueNumber: 1,
    workflowId: 1,
  });
  expect(launch.error.data.status).toBe(409);
  expect(launch.error.message).toContain("start or restart");
  expect({
    pulls: (db.query("SELECT count(*) AS count FROM pulls").get() as any).count,
    runs: (db.query("SELECT count(*) AS count FROM workflow_runs").get() as any)
      .count,
    sessions: (
      db.query("SELECT count(*) AS count FROM agent_sessions").get() as any
    ).count,
  }).toEqual(before);

  const issue: any = await call("issues/get", { repo: "me/proj", number: 1 });
  expect(issue.result.title).toBe("hello");
});

test("search/query routes a repository-scoped query to the search service", async () => {
  const query = vi.spyOn(svc.search, "query").mockReturnValue([
    {
      kind: "issue",
      number: 1,
      title: "hello",
      state: "open",
      snippet: null,
    },
    {
      kind: "pull",
      number: 2,
      title: "hello pull",
      state: "closed",
      snippet: null,
    },
  ]);
  try {
    const searched: any = await call("search/query", {
      repo: "me/proj",
      query: "hello",
    });

    expect(query).toHaveBeenCalledWith("me/proj", "hello");
    expect(searched.result).toEqual([
      {
        kind: "issue",
        number: 1,
        title: "hello",
        state: "open",
        snippet: null,
      },
      {
        kind: "pull",
        number: 2,
        title: "hello pull",
        state: "closed",
        snippet: null,
      },
    ]);
  } finally {
    query.mockRestore();
  }
});

test("workspaces/list routes to the workspace service", async () => {
  const repo = S.getRepo("me", "proj");
  S.createWorkspace(repo!.id, "integration/stack");

  const listed: any = await call("workspaces/list", { repo: "me/proj" });

  expect(listed.result).toEqual([
    expect.objectContaining({
      branch: "integration/stack",
      archived_at: null,
      branch_exists: true,
    }),
  ]);
});

test("workspace settings lists route to settings-specific service methods", async () => {
  const listForSettings = vi
    .spyOn(svc.workspaces, "listForSettings")
    .mockReturnValue([]);
  const listArchivedForSettings = vi
    .spyOn(svc.workspaces, "listArchivedForSettings")
    .mockReturnValue([]);

  try {
    const active: any = await call("workspaces/listForSettings", {
      repo: "me/proj",
    });
    const archived: any = await call("workspaces/listArchivedForSettings", {
      repo: "me/proj",
    });

    expect(active.result).toEqual([]);
    expect(archived.result).toEqual([]);
    expect(listForSettings).toHaveBeenCalledWith("me/proj");
    expect(listArchivedForSettings).toHaveBeenCalledWith("me/proj");
  } finally {
    listForSettings.mockRestore();
    listArchivedForSettings.mockRestore();
  }
});

test("workspaces/create routes to the workspace service", async () => {
  const created: any = await call("workspaces/create", {
    repo: "me/proj",
    branch: "workspace/new",
  });

  expect(created.result).toEqual(
    expect.objectContaining({
      branch: "workspace/new",
      archived_at: null,
      branch_exists: true,
    }),
  );
  expect(
    spawnSync(
      "git",
      ["-C", repoPath, "show-ref", "--verify", "refs/heads/workspace/new"],
      { encoding: "utf8" },
    ).status,
  ).toBe(0);
});

test("workspace archive methods route to the workspace service", async () => {
  svc.workspaces.create("me/proj", { branch: "workspace/archive-me" });

  const archived: any = await call("workspaces/archive", {
    repo: "me/proj",
    branch: "workspace/archive-me",
  });
  expect(archived.result.archived_at).toBeTruthy();

  const listed: any = await call("workspaces/listArchived", {
    repo: "me/proj",
  });
  expect(listed.result).toEqual([
    expect.objectContaining({ branch: "workspace/archive-me" }),
  ]);

  const unarchived: any = await call("workspaces/unarchive", {
    repo: "me/proj",
    branch: "workspace/archive-me",
  });
  expect(unarchived.result.archived_at).toBeNull();
});

test("issues/update accepts a workspace and clear target branch", async () => {
  const issue: any = await call("issues/create", {
    repo: "me/proj",
    title: "rpc movable",
  });

  const moved: any = await call("issues/update", {
    repo: "me/proj",
    number: issue.result.number,
    workspace: "workspace/new",
  });
  expect(moved.result.target_branch).toBe("workspace/new");

  const cleared: any = await call("issues/update", {
    repo: "me/proj",
    number: issue.result.number,
    target_branch: null,
  });
  expect(cleared.result.target_branch).toBeNull();
  const event = S.listEvents(0, 1, 100).find(
    (row) =>
      row.type === "issue.updated" &&
      JSON.parse(row.payload).number === issue.result.number,
  );
  expect(event).toBeTruthy();
});

test("events/list preserves ascending cursor, repo filter, and limit semantics", async () => {
  const repo = S.getRepo("me", "proj");
  expect(repo).not.toBeNull();
  const since = svc.events.newestId();
  svc.events.emit(repo!.id, "issue.updated", "tester", { number: 301 });
  svc.events.emit(null, "system.updated", "tester", { number: 302 });
  svc.events.emit(repo!.id, "issue.updated", "tester", { number: 303 });

  const first: any = await call("events/list", {
    since,
    repo: "me/proj",
    limit: 1,
  });
  expect(first.result).toHaveLength(1);
  expect(first.result[0]).toMatchObject({
    repo: "me/proj",
    payload: { number: 301 },
  });

  const second: any = await call("events/list", {
    since: first.result[0].id,
    repo: "me/proj",
    limit: 10,
  });
  expect(second.result.map((event: any) => event.payload.number)).toEqual([
    303,
  ]);
  expect(second.result[0].id).toBeGreaterThan(first.result[0].id);
});

test("workflowRuns/history exposes only the requested run's lifecycle events", async () => {
  const repo = S.getRepo("me", "proj")!;
  const workflow = S.createWorkflow({
    name: "rpc-history",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 701,
    prNumber: 702,
    status: "running",
    currentStep: "plan",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "55555555-5555-4555-8555-555555555555",
  });
  const otherRun = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 701,
    prNumber: 702,
    status: "running",
    currentStep: "plan",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "66666666-6666-4666-8666-666666666666",
  });
  S.emitEvent(repo.id, "workflow_run.started", "rpc-parent", { id: run.id });
  S.emitEvent(repo.id, "workflow_run.started", "other-parent", {
    id: otherRun.id,
  });

  const response: any = await call("workflowRuns/history", {
    repo: repo.full_name,
    run: run.id,
  });
  expect(response.result).toHaveLength(1);
  expect(response.result[0]).toMatchObject({
    type: "workflow_run.started",
    label: "Run started",
    actor: "rpc-parent",
  });
});

test("workflowRuns/increaseCostLimit raises a cost-held run from a Web session", async () => {
  const increase = vi
    .spyOn(svc.workflowRuns, "increaseCostLimitForHuman")
    .mockReturnValue({
      run: 9,
      increment_usd: 10,
      previous_limit_usd: 10,
      current_limit_usd: 20,
    });

  const response: any = await call("workflowRuns/increaseCostLimit", {
    repo: "me/proj",
    run: 9,
    expected_limit_usd: 10,
    session_id: "77777777-7777-4777-8777-777777777777",
  });
  expect(response.result).toMatchObject({ current_limit_usd: 20 });
  expect(increase).toHaveBeenCalledWith(
    "me/proj",
    { run: 9, expectedLimitUsd: 10 },
    "77777777-7777-4777-8777-777777777777",
  );

  // A run that cannot be increased keeps its visible RPC error instead of recovering.
  increase.mockImplementation(() => {
    throw new ServiceError(409, "Workflow run is not waiting for a human");
  });
  const rejected: any = await call("workflowRuns/increaseCostLimit", {
    repo: "me/proj",
    run: 9,
    expected_limit_usd: 10,
    session_id: "77777777-7777-4777-8777-777777777777",
  });
  expect(rejected.error.message).toContain("not waiting for a human");
  increase.mockRestore();
});

test("issues/create accepts an explicit null target_branch", async () => {
  const created: any = await call("issues/create", {
    repo: "me/proj",
    title: "null target",
    target_branch: null,
  });

  expect(created.result.target_branch).toBeNull();
});

test("pulls/commitFiles routes the PR number and selected SHA", async () => {
  const commitFiles = vi.spyOn(svc.pulls, "commitFiles").mockResolvedValue([]);
  const sha = "a".repeat(40);
  try {
    const response: any = await call("pulls/commitFiles", {
      repo: "me/proj",
      number: 17,
      sha,
    });

    expect(response.result).toEqual([]);
    expect(commitFiles).toHaveBeenCalledWith("me/proj", 17, sha);
  } finally {
    commitFiles.mockRestore();
  }
});

test("pulls/diff routes the whitespace option", async () => {
  const diff = vi.spyOn(svc.pulls, "diff").mockResolvedValue({
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    files: [],
  });
  try {
    const response: any = await call("pulls/diff", {
      repo: "me/proj",
      number: 17,
      path: "src/a.ts",
      ignore_whitespace: true,
    });

    expect(response.result.files).toEqual([]);
    expect(diff).toHaveBeenCalledWith("me/proj", 17, "src/a.ts", true);
  } finally {
    diff.mockRestore();
  }
});

test("unknown method -> -32601", async () => {
  const r: any = await call("nope/nope", {});
  expect(r.error.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
});

test("invalid params -> -32602 with field details", async () => {
  const r: any = await call("issues/create", { repo: "me/proj" }); // missing title
  expect(r.error.code).toBe(ERROR_CODES.INVALID_PARAMS);
  expect(Array.isArray(r.error.data)).toBe(true);
});

test("unknown extra param is rejected (additionalProperties: false)", async () => {
  const r: any = await call("issues/get", {
    repo: "me/proj",
    number: 1,
    bogus: true,
  });
  expect(r.error.code).toBe(ERROR_CODES.INVALID_PARAMS);
});

test.each([
  "session",
  "cwd",
])("terminal/launch rejects retired %s input", async (field) => {
  const r: any = await call("terminal/launch", {
    workflow: "workflow-create",
    prompt: "Create a workflow",
    [field]: "retired",
  });
  expect(r.error.code).toBe(ERROR_CODES.INVALID_PARAMS);
});

test("malformed request (bad jsonrpc) -> -32600", async () => {
  const r: any = await dispatch({
    jsonrpc: "1.0",
    id: 9,
    method: "initialize",
  } as any);
  expect(r.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
});

test("ServiceError maps to -32000 carrying the HTTP-style status", async () => {
  const r: any = await call("issues/get", { repo: "me/proj", number: 999 });
  expect(r.error.code).toBe(ERROR_CODES.APP_ERROR);
  expect(r.error.data.status).toBe(404);
});

test("terminal/sendAgentInput validates its RPC payload and blank input", async () => {
  const missing: any = await call("terminal/sendAgentInput", {
    repo: "me/proj",
    paneId: "w1:p2",
    text: "hello",
  });
  expect(missing.error.code).toBe(ERROR_CODES.INVALID_PARAMS);

  const blank: any = await call("terminal/sendAgentInput", {
    repo: "me/proj",
    pull: 1,
    paneId: "w1:p2",
    text: "   ",
  });
  expect(blank.error.code).toBe(ERROR_CODES.APP_ERROR);
  expect(blank.error.data.status).toBe(422);
  expect(blank.error.message).toBe("text is required");
});

test("terminal/sendAgentInput routes its payload and preserves stale pane/session 409 errors", async () => {
  const send = vi.spyOn(svc.terminal, "sendAgentInput");
  try {
    send.mockRejectedValueOnce(
      new ServiceError(409, "The Herdr agent is no longer running for this PR"),
    );
    const mismatch: any = await call("terminal/sendAgentInput", {
      repo: "me/proj",
      pull: 12,
      paneId: "w1:p9",
      text: "retry",
    });
    expect(send).toHaveBeenNthCalledWith(1, {
      repo: "me/proj",
      pull: 12,
      paneId: "w1:p9",
      text: "retry",
    });
    expect(mismatch.error).toMatchObject({
      code: ERROR_CODES.APP_ERROR,
      message: "The Herdr agent is no longer running for this PR",
      data: { status: 409 },
    });

    send.mockRejectedValueOnce(
      new ServiceError(409, "The Herdr session is no longer available"),
    );
    const disappeared: any = await call("terminal/sendAgentInput", {
      repo: "me/proj",
      pull: 12,
      paneId: "w1:p2",
      text: "retry",
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      repo: "me/proj",
      pull: 12,
      paneId: "w1:p2",
      text: "retry",
    });
    expect(disappeared.error).toMatchObject({
      code: ERROR_CODES.APP_ERROR,
      message: "The Herdr session is no longer available",
      data: { status: 409 },
    });
  } finally {
    send.mockRestore();
  }
});

test("a notification (no id) produces no response", async () => {
  const r = await dispatch({
    jsonrpc: "2.0",
    method: "issues/create",
    params: { repo: "me/proj", title: "n" },
  });
  expect(r).toBeNull();
});

test("batch returns an array; empty batch -> -32600", async () => {
  const batch: any = await dispatch([
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    {
      jsonrpc: "2.0",
      method: "issues/create",
      params: { repo: "me/proj", title: "notif" },
    }, // notification: omitted
    {
      jsonrpc: "2.0",
      id: 2,
      method: "labels/list",
      params: { repo: "me/proj" },
    },
  ]);
  expect(Array.isArray(batch)).toBe(true);
  expect(batch.map((x: any) => x.id)).toEqual([1, 2]);

  const empty: any = await dispatch([]);
  expect(empty.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
});

test("batch dispatches at the element limit", async () => {
  const batch: any = await dispatch(
    Array.from({ length: MAX_RPC_BATCH_SIZE }, (_, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "initialize",
    })),
  );

  expect(batch).toHaveLength(MAX_RPC_BATCH_SIZE);
  expect(batch[0].id).toBe(1);
  expect(batch.at(-1).id).toBe(MAX_RPC_BATCH_SIZE);
});

test("batch over the element limit is rejected before dispatch", async () => {
  const before = await svc.issues.list("me/proj");
  const batch: any = await dispatch([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "issues/create",
      params: { repo: "me/proj", title: "must not be created" },
    },
    ...Array.from({ length: MAX_RPC_BATCH_SIZE }, (_, index) => ({
      jsonrpc: "2.0",
      id: index + 2,
      method: "initialize",
    })),
  ]);

  expect(batch.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
  expect(batch.error.message).toContain(`max ${MAX_RPC_BATCH_SIZE}`);
  expect(await svc.issues.list("me/proj")).toHaveLength(before.length);
});

test("dashboard/overview lists recent open issues newest-created first, tagged with their repo", async () => {
  // Lower number created first, higher number second. We then stamp created_at
  // so the *lower-numbered* issue is the newest, which contradicts the
  // number-DESC tie-break — so the assertion below only passes if the section
  // is genuinely ordered by created_at (byCreatedDesc), not by number.
  const lowNum: any = await call("issues/create", {
    repo: "me/proj",
    title: "stamped-newest",
  });
  const highNum: any = await call("issues/create", {
    repo: "me/proj",
    title: "stamped-oldest",
  });
  const setCreatedAt = (title: string, createdAt: string) =>
    db.run("UPDATE issues SET created_at = ? WHERE title = ?", [
      createdAt,
      title,
    ]);
  setCreatedAt("stamped-newest", "2025-01-02T00:00:00Z");
  setCreatedAt("stamped-oldest", "2025-01-01T00:00:00Z");

  const r: any = await call("dashboard/overview", {});
  expect(Array.isArray(r.result.issues)).toBe(true);
  // The cap is surfaced so the UI can note when the list is truncated.
  expect(r.result.recentIssuesLimit).toBe(100);

  // Both open issues appear regardless of assignment.
  const titles = r.result.issues.map((it: any) => it.issue.title);
  expect(titles).toContain("stamped-newest");
  expect(titles).toContain("stamped-oldest");

  // Newest-created first, even though it has the lower issue number.
  expect(titles.indexOf("stamped-newest")).toBeLessThan(
    titles.indexOf("stamped-oldest"),
  );

  const mine = r.result.issues.find(
    (it: any) => it.issue.number === lowNum.result.number,
  );
  expect(mine).toBeTruthy();
  expect(mine.repo).toEqual({
    full_name: "me/proj",
    owner: "me",
    name: "proj",
  });

  // Closed issues are excluded.
  await call("issues/update", {
    repo: "me/proj",
    number: highNum.result.number,
    state: "closed",
  });
  const r2: any = await call("dashboard/overview", {});
  expect(
    r2.result.issues.some((it: any) => it.issue.title === "stamped-oldest"),
  ).toBe(false);
});

test("workflow CRUD is exposed through JSON-RPC", async () => {
  const created: any = await call("workflows/create", {
    name: " standard ",
    description: "Reusable Workflow prompts",
    execute_prompt: "Implement",
    verify_prompt: "",
  });
  expect(created.result).toMatchObject({
    name: "standard",
    description: "Reusable Workflow prompts",
    execute_prompt: "Implement",
  });

  const listed: any = await call("workflows/list", {});
  expect(listed.result.map((w: any) => w.name)).toContain("standard");

  const contracts: any = await call("workflows/contracts", {});
  expect(contracts.result.execute).toContain("# Execute step contract");
  expect(contracts.result.verify).toContain("# Verify step contract");

  const updated: any = await call("workflows/update", {
    name: "standard",
    new_name: "standard-v2",
    verify_prompt: "Verify independently",
  });
  expect(updated.result.name).toBe("standard-v2");
  expect(updated.result.verify_prompt).toBe("Verify independently");
  expect(updated.result.execute_prompt).toBe("Implement");

  const deleted: any = await call("workflows/delete", {
    name: "standard-v2",
  });
  expect(deleted.result).toEqual({ ok: true });
});

test("settings RPC persists and selects the workflow contract language", async () => {
  const updated: any = await call("settings/update", {
    workflowContractLanguage: "ja",
  });
  expect(updated.result.workflowContractLanguage).toBe("ja");

  const contracts: any = await call("workflows/contracts", {});
  expect(contracts.result.execute).toContain("# Execute ステップ contract");

  await call("settings/update", { workflowContractLanguage: "en" });
});

test("settings RPC persists and validates the application theme", async () => {
  const updated: any = await call("settings/update", { theme: "forest" });
  expect(updated.result.theme).toBe("forest");

  const got: any = await call("settings/get", {});
  expect(got.result.theme).toBe("forest");

  const invalid: any = await call("settings/update", { theme: "neon" });
  expect(invalid.error.code).toBe(ERROR_CODES.INVALID_PARAMS);
});

test("dispatchRaw turns invalid JSON into -32700", async () => {
  const r: any = await dispatchRaw("{not json");
  expect(r.error.code).toBe(ERROR_CODES.PARSE_ERROR);
});
