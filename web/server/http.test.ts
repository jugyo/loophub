import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
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
let MAX_RPC_REQUEST_BYTES: number;
let MAX_RPC_RESPONSE_BYTES: number;
let ERROR_CODES: typeof import("./rpc.ts").ERROR_CODES;

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

function rpcBodyOfSize(bytes: number): string {
  const prefix = '{"jsonrpc":"2.0","id":"';
  const suffix = '","method":"initialize","params":{}}';
  return `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`;
}

async function postChunkedRpc(
  body: string,
  chunkSize: number,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}/rpc`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    req.on("error", reject);
    let offset = 0;
    const writeNext = () => {
      if (offset >= body.length) {
        req.end();
        return;
      }
      req.write(body.slice(offset, offset + chunkSize));
      offset += chunkSize;
      setTimeout(writeNext, 1);
    };
    writeNext();
  });
}

beforeAll(async () => {
  const http = await import("./http.ts");
  MAX_RPC_REQUEST_BYTES = http.MAX_RPC_REQUEST_BYTES;
  MAX_RPC_RESPONSE_BYTES = http.MAX_RPC_RESPONSE_BYTES;
  ({ ERROR_CODES } = await import("./rpc.ts"));
  S = await import("../../core/store.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-http-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  server = http.createLhWebServer();
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

test("POST /rpc accepts a request exactly at the byte limit", async () => {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rpcBodyOfSize(MAX_RPC_REQUEST_BYTES),
  });

  expect(res.status).toBe(200);
  expect(((await res.json()) as any).result.serverInfo.name).toBe("loophub");
});

test("POST /rpc rejects a request over the byte limit", async () => {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rpcBodyOfSize(MAX_RPC_REQUEST_BYTES + 1),
  });
  const body = (await res.json()) as any;

  expect(res.status).toBe(413);
  expect(body.error.code).toBe(ERROR_CODES.REQUEST_TOO_LARGE);
  expect(body.error.data).toEqual({
    status: 413,
    maxBytes: MAX_RPC_REQUEST_BYTES,
  });
});

test("POST /rpc drains slow chunked input after it exceeds the byte limit", async () => {
  const oversized = rpcBodyOfSize(MAX_RPC_REQUEST_BYTES + 1);
  const res = await postChunkedRpc(oversized, 64 * 1024);

  expect(res.status).toBe(413);
  expect(res.body.error.code).toBe(ERROR_CODES.REQUEST_TOO_LARGE);
  expect(res.body.error.data.maxBytes).toBe(MAX_RPC_REQUEST_BYTES);
  expect((await rpc("initialize", {})).status).toBe(200);
});

test("POST /rpc replaces an oversized serialized response with an error", async () => {
  const repo = S.getRepo("me", "proj")!;
  const issue = S.createIssue(
    repo.id,
    "issue",
    "large response",
    "x".repeat(MAX_RPC_RESPONSE_BYTES),
    "me",
  );
  const res = await rpc(
    "issues/get",
    { repo: "me/proj", number: issue.number },
    77,
  );

  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    jsonrpc: "2.0",
    id: 77,
    error: {
      code: ERROR_CODES.RESPONSE_TOO_LARGE,
      message: "Response too large",
    },
  });
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

test("GET /events returns Gone instead of the SPA fallback", async () => {
  const res = await fetch(`${base}/events`);

  expect(res.status).toBe(410);
  expect(await res.text()).toBe("Gone\n");
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
  expect(get.headers.get("content-disposition")).toBeNull();
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

test("POST /attachments stores HTML; GET downloads it with a safe filename", async () => {
  const html = Buffer.from("<!doctype html><script>alert('no')</script>");
  const filename = '../../dangerous".html';
  const params = new URLSearchParams({ filename, actor: "me" });
  const res = await fetch(`${base}/attachments?${params}`, {
    method: "POST",
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.mime).toBe("text/html");
  expect(body.markdown).toBe(`[${filename}](/attachments/${body.sha256})`);

  const get = await fetch(`${base}${body.url}`);
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toBe("text/html");
  expect(get.headers.get("content-disposition")).toBe(
    'attachment; filename="dangerous_.html"',
  );
  expect(get.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await get.arrayBuffer()).equals(html)).toBe(true);
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

test("POST /attachments stores a Markdown document; GET displays it as UTF-8 text", async () => {
  const doc = Buffer.from("# 調査結果\n\n- ひとつめ\n");
  const res = await fetch(`${base}/attachments?filename=findings.md&actor=me`, {
    method: "POST",
    headers: { "content-type": "text/markdown" },
    body: doc,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.mime).toBe("text/markdown");
  expect(body.markdown).toBe(`[findings.md](/attachments/${body.sha256})`);

  // Served inline as plain text: a text/markdown response would be downloaded,
  // and a charset-less one would garble the Japanese content.
  const get = await fetch(`${base}${body.url}`);
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(get.headers.get("content-disposition")).toBeNull();
  expect(get.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await get.text()).toBe(doc.toString("utf8"));
});

test("POST /attachments rejects unsupported MIME / extension", async () => {
  const res = await fetch(`${base}/attachments?filename=note.pdf`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body: Buffer.from("hello"),
  });
  expect(res.status).toBe(415);
});

test("POST /attachments rejects HTML with a mismatched MIME type", async () => {
  const res = await fetch(`${base}/attachments?filename=report.html`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Buffer.from("<!doctype html>"),
  });
  expect(res.status).toBe(415);
});

test("GET /attachments/:sha256 404s for an invalid attachment ID", async () => {
  const res = await fetch(`${base}/attachments/not-a-sha256`);
  expect(res.status).toBe(404);
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
