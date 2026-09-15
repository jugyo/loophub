import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const CLI = join(import.meta.dirname, "../index.ts");
let server: ReturnType<typeof Bun.serve>;
let url: string;

async function lh(args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, LOOPHUB_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json();
    const result = body.method === "missing"
      ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }
      : { jsonrpc: "2.0", id: body.id, result: { method: body.method, params: body.params } };
    return Response.json(result);
  }});
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop());

test("calls an RPC method and prints its result", async () => {
  const result = await lh(["rpc", "issues/list", "--params", '{"repo":"me/app"}', "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ method: "issues/list", params: { repo: "me/app" } });
});

test("reports invalid params and RPC errors", async () => {
  const invalid = await lh(["rpc", "initialize", "--params", "{"]);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr).toContain("invalid params JSON");

  const rpcError = await lh(["rpc", "missing"]);
  expect(rpcError.exitCode).not.toBe(0);
  expect(rpcError.stderr).toContain("RPC error -32601: Method not found");
});
