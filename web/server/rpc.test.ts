import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the DB before contract.ts -> service.ts -> db.ts runs its import-time setup.
const HOME = mkdtempSync(join(tmpdir(), "lh-rpc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let dispatch: typeof import("./rpc.ts").dispatch;
let dispatchRaw: typeof import("./rpc.ts").dispatchRaw;
let ERROR_CODES: typeof import("./rpc.ts").ERROR_CODES;
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function call(method: string, params?: any, id: any = 1) {
  return dispatch({ jsonrpc: "2.0", id, method, params });
}

beforeAll(async () => {
  ({ dispatch, dispatchRaw, ERROR_CODES } = await import("./rpc.ts"));

  repoPath = mkdtempSync(join(tmpdir(), "lh-rpc-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  const r: any = await call("repos/create", { path: repoPath, name: "me/proj" });
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
  const created: any = await call("issues/create", { repo: "me/proj", title: "hello", body: "b" });
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
  const r: any = await call("issues/get", { repo: "me/proj", number: 1, bogus: true });
  expect(r.error.code).toBe(ERROR_CODES.INVALID_PARAMS);
});

test("malformed request (bad jsonrpc) -> -32600", async () => {
  const r: any = await dispatch({ jsonrpc: "1.0", id: 9, method: "initialize" } as any);
  expect(r.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
});

test("ServiceError maps to -32000 carrying the HTTP-style status", async () => {
  const r: any = await call("issues/get", { repo: "me/proj", number: 999 });
  expect(r.error.code).toBe(ERROR_CODES.APP_ERROR);
  expect(r.error.data.status).toBe(404);
});

test("a notification (no id) produces no response", async () => {
  const r = await dispatch({ jsonrpc: "2.0", method: "issues/create", params: { repo: "me/proj", title: "n" } });
  expect(r).toBeNull();
});

test("batch returns an array; empty batch -> -32600", async () => {
  const batch: any = await dispatch([
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", method: "issues/create", params: { repo: "me/proj", title: "notif" } }, // notification: omitted
    { jsonrpc: "2.0", id: 2, method: "labels/list", params: { repo: "me/proj" } },
  ]);
  expect(Array.isArray(batch)).toBe(true);
  expect(batch.map((x: any) => x.id)).toEqual([1, 2]);

  const empty: any = await dispatch([]);
  expect(empty.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
});

test("dashboard/overview lists assigned issues tagged with their repo", async () => {
  const sid = "11111111-1111-1111-1111-111111111111";
  await call("sessions/register", { id: sid, agent: "impl-bot", session: "wip-runtime" });
  const wip: any = await call("issues/create", { repo: "me/proj", title: "wip" });
  await call("issues/assign", { repo: "me/proj", number: wip.result.number, session_id: sid });
  await call("issues/create", { repo: "me/proj", title: "idle" }); // unassigned -> excluded

  const r: any = await call("dashboard/overview", {});
  expect(Array.isArray(r.result.issues)).toBe(true);
  expect(Array.isArray(r.result.pulls)).toBe(true);

  const mine = r.result.issues.find((it: any) => it.issue.number === wip.result.number);
  expect(mine).toBeTruthy();
  expect(mine.repo).toEqual({ full_name: "me/proj", owner: "me", name: "proj" });
  expect(r.result.issues.some((it: any) => it.issue.title === "idle")).toBe(false);
});

test("dashboard/overview lists open unmerged PRs tagged with their repo", async () => {
  // A PR head must exist as a branch for pulls/create to resolve its sha.
  git(["checkout", "-q", "-b", "feat-x"]);
  writeFileSync(join(repoPath, "b.txt"), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feat"]);
  git(["checkout", "-q", "main"]);

  const pr: any = await call("pulls/create", {
    repo: "me/proj",
    title: "feature pr",
    head: "feat-x",
    base: "main",
  });
  expect(pr.result.number).toBeTypeOf("number");

  const r: any = await call("dashboard/overview", {});
  const mine = r.result.pulls.find((it: any) => it.pull.number === pr.result.number);
  expect(mine).toBeTruthy();
  expect(mine.repo).toEqual({ full_name: "me/proj", owner: "me", name: "proj" });
  expect(mine.pull.merged).toBe(false);
});

test("dispatchRaw turns invalid JSON into -32700", async () => {
  const r: any = await dispatchRaw("{not json");
  expect(r.error.code).toBe(ERROR_CODES.PARSE_ERROR);
});
