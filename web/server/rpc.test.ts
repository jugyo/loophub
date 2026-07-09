import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before contract.ts -> service.ts -> db.ts runs its import-time setup.
const HOME = mkdtempSync(join(tmpdir(), "lh-rpc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let dispatch: typeof import("./rpc.ts").dispatch;
let dispatchRaw: typeof import("./rpc.ts").dispatchRaw;
let ERROR_CODES: typeof import("./rpc.ts").ERROR_CODES;
let db: typeof import("../../core/db.ts").db;
let svc: typeof import("../../core/service.ts");
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function call(method: string, params?: any, id: any = 1) {
  return dispatch({ jsonrpc: "2.0", id, method, params });
}

beforeAll(async () => {
  ({ dispatch, dispatchRaw, ERROR_CODES } = await import("./rpc.ts"));
  ({ db } = await import("../../core/db.ts"));
  svc = await import("../../core/service.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-rpc-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

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
  const r: any = await call("initialize", {});
  expect(r.result.protocolVersion).toBeTypeOf("string");
  expect(r.result.serverInfo.name).toBe("loophub");
  expect(r.result.capabilities.methods).toContain("issues/create");
  expect(r.result.capabilities.notifications).toContain("events/notify");
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

test("inbox/list, inbox/get, and state mutations expose Inbox messages through JSON-RPC", async () => {
  const first = svc.inbox.send("me/proj", {
    from: { kind: "agent", repo: "me/proj", actor: "impl-bot" },
    title: "Ready for review",
    body: "PR #12 is ready.\nPlease check the evidence.",
    label: "review",
  });
  const second = svc.inbox.send("me/proj", {
    from: { kind: "agent", repo: "me/proj", actor: "verifier" },
    to: { kind: "human" },
    title: "Follow-up",
    body: "One more thing",
  });
  const third = svc.inbox.send("me/proj", {
    from: { kind: "agent", repo: "me/proj", actor: "cleaner" },
    title: "Can be removed",
    body: "Remove from active view",
  });

  const read: any = await call("inbox/read", { id: first.id });
  expect(read.result.state).toBe("read");
  const archived: any = await call("inbox/archive", { id: second.id });
  expect(archived.result.state).toBe("archived");
  const deleted: any = await call("inbox/delete", { id: third.id });
  expect(deleted.result.state).toBe("deleted");

  const listed: any = await call("inbox/list", {});
  expect(listed.result.map((m: any) => m.id)).toContain(first.id);
  expect(listed.result.map((m: any) => m.id)).not.toContain(second.id);
  expect(listed.result.map((m: any) => m.id)).not.toContain(third.id);
  const listFirst = listed.result.find((m: any) => m.id === first.id);
  expect(listFirst).toMatchObject({
    repo: { name: "me/proj" },
    to: null,
    label: "review",
    title: "Ready for review",
    body: "PR #12 is ready.\nPlease check the evidence.",
    state: "read",
  });

  const archivedList: any = await call("inbox/list", { state: "archived" });
  expect(archivedList.result.map((m: any) => m.id)).toContain(second.id);

  const got: any = await call("inbox/get", { id: second.id });
  expect(got.result).toMatchObject({
    id: second.id,
    repo: { name: "me/proj" },
    from: { kind: "agent", repo: "me/proj", actor: "verifier" },
    to: { kind: "human" },
    state: "archived",
  });

  const unarchived: any = await call("inbox/unarchive", { id: second.id });
  expect(unarchived.result.state).toBe("read");
});

test("PEVR workflow CRUD is exposed through JSON-RPC", async () => {
  const created: any = await call("pevrWorkflows/create", {
    name: " standard ",
    description: "Reusable PEVR prompts",
    plan_prompt: "",
    execute_prompt: "Implement",
    verify_prompt: "",
    reflect_prompt: "",
  });
  expect(created.result).toMatchObject({
    name: "standard",
    description: "Reusable PEVR prompts",
    execute_prompt: "Implement",
  });

  const listed: any = await call("pevrWorkflows/list", {});
  expect(listed.result.map((w: any) => w.name)).toContain("standard");

  const updated: any = await call("pevrWorkflows/update", {
    name: "standard",
    new_name: "standard-v2",
    plan_prompt: "Plan first",
  });
  expect(updated.result.name).toBe("standard-v2");
  expect(updated.result.plan_prompt).toBe("Plan first");
  expect(updated.result.execute_prompt).toBe("Implement");

  const got: any = await call("pevrWorkflows/get", { name: "standard-v2" });
  expect(got.result.id).toBe(created.result.id);

  const deleted: any = await call("pevrWorkflows/delete", {
    name: "standard-v2",
  });
  expect(deleted.result).toEqual({ ok: true });
});

test("dispatchRaw turns invalid JSON into -32700", async () => {
  const r: any = await dispatchRaw("{not json");
  expect(r.error.code).toBe(ERROR_CODES.PARSE_ERROR);
});
