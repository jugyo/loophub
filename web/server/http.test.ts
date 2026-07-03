import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before http.ts -> rpc.ts -> contract.ts -> service.ts -> db.ts.
const HOME = mkdtempSync(join(tmpdir(), "lh-http-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");
// Point static serving at an isolated dist dir so the test is independent of whether
// the real web/dist has been built.
const DIST = join(HOME, "dist");
process.env.LOOPHUB_WEB_DIST = DIST;

let server: Server;
let base: string;
let repoPath: string;
let S: typeof import("../../core/store.ts");

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function rpc(method: string, params?: any, id: any = 1) {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return {
    status: res.status,
    body: (res.status === 204 ? null : await res.json()) as any,
  };
}

beforeAll(async () => {
  const { createLhWebServer } = await import("./http.ts");
  S = await import("../../core/store.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-http-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  server = createLhWebServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const r = await rpc("repos/create", { path: repoPath, name: "me/proj" });
  expect(r.body.result.full_name).toBe("me/proj");
});

afterAll(() => {
  server?.close();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("POST /rpc routes a method and returns its result", async () => {
  const init = await rpc("initialize", {});
  expect(init.status).toBe(200);
  expect(init.body.result.serverInfo.name).toBe("loophub");

  const created = await rpc("issues/create", { repo: "me/proj", title: "hi" });
  expect(created.body.result.number).toBe(1);
});

test("POST /rpc with invalid JSON returns a -32700 error", async () => {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).error.code).toBe(-32700);
});

test("POST /rpc rejects non-JSON content types", async () => {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  expect(res.status).toBe(415);
});

test("POST /rpc rejects a non-loopback Origin by default (DNS-rebinding defense, #465)", async () => {
  // With no LOOPHUB_HOST override (the default, loopback-bound deployment), a non-loopback Origin
  // is suspicious — e.g. a DNS-rebound attacker page whose Origin string is still its own hostname
  // even once that hostname resolves to 127.0.0.1 — and must be rejected even without Sec-Fetch-Site.
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://evil.example:8730",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  expect(res.status).toBe(403);
});

test("POST /rpc allows a non-loopback Origin once LOOPHUB_HOST opts into a non-loopback bind (#465)", async () => {
  // LOOPHUB_HOST=0.0.0.0 (LAN access, web/server/index.ts) makes the SPA's own same-origin
  // requests carry a non-loopback Origin hostname — those must still work once the operator has
  // opted into that broadened exposure, same tradeoff the terminal feature already makes there.
  const prevHost = process.env.LOOPHUB_HOST;
  process.env.LOOPHUB_HOST = "0.0.0.0";
  try {
    const res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://192.168.1.50:8730",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(200);
  } finally {
    if (prevHost === undefined) delete process.env.LOOPHUB_HOST;
    else process.env.LOOPHUB_HOST = prevHost;
  }
});

test("POST /rpc rejects cross-site fetch metadata", async () => {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  expect(res.status).toBe(403);
});

test("POST /rpc with only notifications returns 204", async () => {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "issues/create",
      params: { repo: "me/proj", title: "n" },
    }),
  });
  expect(res.status).toBe(204);
});

test("GET /events streams replayed then live events as SSE notifications", async () => {
  const repo = S.getRepo("me", "proj")!;
  // Start the cursor after any events left by earlier tests, so replay is deterministic.
  const all = S.listEvents(0, repo.id, 1000);
  const since = all.length ? all[all.length - 1].id : 0;
  S.emitEvent(repo.id, "issue.opened", "me", { number: 100 });
  S.emitEvent(repo.id, "issue.opened", "me", { number: 101 });

  const ctrl = new AbortController();
  const res = await fetch(`${base}/events?since=${since}&repo=me/proj`, {
    signal: ctrl.signal,
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";

  // Collect SSE `loophub` frames until we have `count`, or time out.
  async function until(count: number): Promise<any[]> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const frames = buf
        .split("\n\n")
        .filter((f) => f.startsWith("event: loophub"))
        .map((f) => JSON.parse(f.split("\ndata: ")[1]));
      if (frames.length >= count) return frames;
      if (Date.now() > deadline)
        throw new Error(`timed out: got ${frames.length}/${count}`);
      const timer = new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
        setTimeout(() => r({ done: true }), deadline - Date.now()),
      );
      const { value, done } = await Promise.race([reader.read(), timer]);
      if (done && !value)
        throw new Error(`timed out: got ${frames.length}/${count}`);
      if (value) buf += dec.decode(value, { stream: true });
    }
  }

  const replayed = await until(2);
  expect(replayed.map((n) => n.params.payload.number)).toEqual([100, 101]);
  expect(replayed[0].method).toBe("events/notify");

  // a live event reaches the open stream
  S.emitEvent(repo.id, "issue.closed", "me", { number: 100 });
  const withLive = await until(3);
  expect(withLive[2].params.type).toBe("issue.closed");

  ctrl.abort();
});

// #591: a bare, non-persisted `event: terminal` frame -- distinct from `event: loophub` --
// reaches every open /events connection when the herdr watcher (or, here, the test directly)
// publishes to terminal-watch-hub. It carries no id/replay semantics, so the client re-fetches
// terminal/sessions over JSON-RPC on receipt instead of parsing a payload.
test("GET /events also streams `terminal` frames published on terminal-watch-hub", async () => {
  const { publish } = await import("../../core/terminal-watch-hub.ts");

  const ctrl = new AbortController();
  const res = await fetch(`${base}/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";

  // Re-publish on a short interval: the very first publish() can race the connection's
  // subscribeTerminalWatch call completing server-side, so keep nudging until a frame shows up.
  const republish = setInterval(publish, 50);
  publish();

  const deadline = Date.now() + 2000;
  try {
    for (;;) {
      if (buf.includes("event: terminal\ndata: {}\n\n")) break;
      if (Date.now() > deadline)
        throw new Error("timed out waiting for terminal frame");
      const timer = new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
        setTimeout(() => r({ done: true }), 100),
      );
      const { value, done } = await Promise.race([reader.read(), timer]);
      if (done && !value) continue;
      if (value) buf += dec.decode(value, { stream: true });
    }
  } finally {
    clearInterval(republish);
  }

  ctrl.abort();
});

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("POST /attachments stores a blob and returns url + markdown; GET streams it", async () => {
  const res = await fetch(`${base}/attachments?filename=shot.png&actor=me`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: PNG,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(body.url).toBe(`/attachments/${body.sha256}`);
  expect(body.markdown).toBe(`![shot.png](/attachments/${body.sha256})`);

  // GET returns the bytes with the recorded content-type and nosniff.
  const get = await fetch(`${base}${body.url}`);
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toBe("image/png");
  expect(get.headers.get("x-content-type-options")).toBe("nosniff");
  const bytes = Buffer.from(await get.arrayBuffer());
  expect(bytes.equals(PNG)).toBe(true);

  // Re-uploading the same bytes dedups to the same sha256.
  const again = await fetch(`${base}/attachments?filename=other.png&actor=me`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: PNG,
  });
  expect(((await again.json()) as any).sha256).toBe(body.sha256);
});

test("POST /attachments accepts application/octet-stream for a valid extension", async () => {
  // Mirrors a browser drop where File.type is empty -> client sends octet-stream.
  const res = await fetch(`${base}/attachments?filename=drop.png&actor=me`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from([1, 2, 3, 4, 5]),
  });
  expect(res.status).toBe(201);
  expect(((await res.json()) as any).mime).toBe("image/png");
});

test("POST /attachments rejects non-image MIME / extension", async () => {
  const res = await fetch(`${base}/attachments?filename=note.txt`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: Buffer.from("hello"),
  });
  expect(res.status).toBe(415);
});

test("GET /attachments/:sha256 404s for an unknown blob", async () => {
  const res = await fetch(`${base}/attachments/${"0".repeat(64)}`);
  expect(res.status).toBe(404);
});

test("GET on a client route 404s when the SPA is not built", async () => {
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("Not built");
});

test("GET on a client route serves index.html when the SPA is built (fallback)", async () => {
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "index.html"), "<!doctype html><title>lh</title>");
  const res = await fetch(`${base}/r/me/proj/issues/1`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("<!doctype html>");
});
