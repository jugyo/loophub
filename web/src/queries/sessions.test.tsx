import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "./keys";
import { useAgentCostSummary, useAgentSessions } from "./sessions";

function rpcMethod(call: unknown): string {
  const [, init] = call as [string, RequestInit];
  return JSON.parse(String(init.body)).method;
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session queries", () => {
  it("does not refetch the cost summary when agent sessions are invalidated", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(
      () => {
        useAgentSessions();
        useAgentCostSummary();
      },
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await client.invalidateQueries({ queryKey: queryKeys.agentSessions() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const methods = fetchMock.mock.calls.map(rpcMethod);
    expect(methods.filter((method) => method === "sessions/list")).toHaveLength(
      2,
    );
    expect(
      methods.filter((method) => method === "sessions/costSummary"),
    ).toHaveLength(1);
  });
});
