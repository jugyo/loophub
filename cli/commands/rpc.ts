import { baseUrl } from "../../core/config.ts";
import { flags, pos } from "../args.ts";
import { fail, out } from "../context.ts";

export async function run(): Promise<void> {
  const method = pos[1];
  if (!method) fail("lh rpc requires a method");

  let params: unknown = {};
  if (flags.params !== undefined) {
    try {
      params = JSON.parse(flags.params);
    } catch (error) {
      fail(`invalid params JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (error) {
    fail(`RPC request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let body: any;
  try {
    body = await response.json();
  } catch {
    fail(`RPC request failed: HTTP ${response.status}`);
  }
  if (body?.error) {
    fail(`RPC error ${body.error.code}: ${body.error.message}`);
  }
  if (!response.ok || !("result" in (body ?? {}))) {
    fail(`RPC request failed: HTTP ${response.status}`);
  }
  out(body.result);
  if (!flags.json) console.log(JSON.stringify(body.result));
}
