// Test helper: a `fetch` mock that speaks JSON-RPC. Every client call is POST /rpc with a
// { method, params } body, so component tests stub fetch with method->handler routing
// instead of REST URL matching.
import { vi } from "vitest";

/** Throw from a handler to produce a JSON-RPC error carrying an HTTP-style status. */
export class RpcFault {
  constructor(
    public status: number,
    public message: string,
  ) {}
}

type Handler = (params: any) => unknown | Promise<unknown>;

export function mockRpcFetch(handlers: Record<string, Handler>) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body ?? "{}"));
    const send = (obj: unknown) =>
      new Response(JSON.stringify(obj), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const handler = handlers[method];
    if (!handler) return send({ jsonrpc: "2.0", id: 1, result: {} });
    try {
      const result = await handler(params);
      return send({ jsonrpc: "2.0", id: 1, result });
    } catch (e) {
      if (e instanceof RpcFault) {
        return send({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: e.message,
            data: { status: e.status },
          },
        });
      }
      throw e;
    }
  });
}

/** The JSON-RPC request body for the first stubbed-fetch call to `method`, if any. */
export function rpcCall(
  method: string,
): { method: string; params: any } | undefined {
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
  for (const c of fetchMock.mock.calls) {
    const body = JSON.parse(String((c[1] as RequestInit).body));
    if (body.method === method) return body;
  }
  return undefined;
}
