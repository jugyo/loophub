import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopEvent } from "@/api/types";
import { useLoopHubEvents } from "./use-loophub-events";

function ev(id: number, type = "issue.updated"): LoopEvent {
  return {
    id,
    type,
    actor: "me",
    repo: "me/proj",
    payload: { number: 3 },
    created_at: "2026-07-04T00:00:00Z",
  };
}

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    headers: { "content-type": "application/json" },
  });
}

function rpcParams(call: unknown): Record<string, unknown> {
  const [, init] = call as [string, RequestInit];
  return JSON.parse(String(init.body)).params;
}

function HookHarness() {
  useLoopHubEvents();
  return null;
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

// A client with no stored cursor spends its first call learning the newest event id, so tests
// about steady-state polling start from a cursor as a live client would. `warmCursor` keeps that
// setup next to the mocked responses it has to agree with.
function warmCursor(id: number): void {
  localStorage.setItem("lh_last_event_id", String(id));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useLoopHubEvents", () => {
  it("does not poll again when its host component rerenders", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();

    const rendered = render(<HookHarness />, { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rendered.rerender(<HookHarness />);
    rendered.rerender(<HookHarness />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("invalidates a shared key once for a whole batch of events", async () => {
    warmCursor(1);
    const batch = Array.from({ length: 20 }, (_, i) => ev(i + 1));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(batch))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    render(<HookHarness />, { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());

    // All 20 events are repo-scoped, so each one maps to the repo's activity feed key. Invalidating
    // per event would cancel and restart the in-flight refetch of every query under that prefix.
    const feedKey = JSON.stringify(["events", "me/proj"]);
    const feedCalls = invalidate.mock.calls.filter(
      ([filters]) => JSON.stringify(filters?.queryKey) === feedKey,
    );
    expect(feedCalls).toHaveLength(1);
  });

  it("skips the history instead of replaying it when there is no stored cursor", async () => {
    localStorage.removeItem("lh_last_event_id");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([ev(5000)]))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    render(<HookHarness />, { wrapper: wrapper(client) });

    // Asking for the newest id costs one call; replaying from 0 would page through every event
    // ever recorded, invalidating the same keys once per page.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(rpcParams(fetchMock.mock.calls[0])).toEqual({
      since: 0,
      order: "desc",
      limit: 1,
    });
    await vi.waitFor(() =>
      expect(localStorage.getItem("lh_last_event_id")).toBe("5000"),
    );
    expect(invalidate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(rpcParams(fetchMock.mock.calls[1])).toEqual({
      since: 5000,
      limit: 100,
    });
  });

  it("uses the visibility-specific cadence and reschedules on visibility changes", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);

    render(<HookHarness />, { wrapper: wrapper(new QueryClient()) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("continues polling after an RPC error", async () => {
    warmCursor(1);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporary RPC failure"))
      .mockResolvedValue(jsonResponse([ev(7)]));
    vi.stubGlobal("fetch", fetchMock);

    render(<HookHarness />, { wrapper: wrapper(new QueryClient()) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1500);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(rpcParams(fetchMock.mock.calls[1])).toEqual({
      since: 1,
      limit: 100,
    });
    await vi.waitFor(() =>
      expect(localStorage.getItem("lh_last_event_id")).toBe("7"),
    );
  });

  it("immediately pages through a backlog that fills the polling limit", async () => {
    warmCursor(1);
    const firstPage = Array.from({ length: 100 }, (_, i) => ev(i + 1));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([ev(101)]))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);

    render(<HookHarness />, { wrapper: wrapper(new QueryClient()) });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(rpcParams(fetchMock.mock.calls[0])).toEqual({
      since: 1,
      limit: 100,
    });
    expect(rpcParams(fetchMock.mock.calls[1])).toEqual({
      since: 100,
      limit: 100,
    });
    await vi.waitFor(() =>
      expect(localStorage.getItem("lh_last_event_id")).toBe("101"),
    );
  });

  it("polls events/list in each mounted tab", async () => {
    warmCursor(1);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse([ev(7)])));
    vi.stubGlobal("fetch", fetchMock);

    const clients = Array.from({ length: 7 }, () => new QueryClient());
    const invalidates = clients.map((client) =>
      vi.spyOn(client, "invalidateQueries"),
    );

    const renders = clients.map((client) =>
      render(<HookHarness />, { wrapper: wrapper(client) }),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    expect(fetchMock).toHaveBeenCalledWith(
      "/rpc",
      expect.objectContaining({ method: "POST" }),
    );
    for (const call of fetchMock.mock.calls) {
      expect(rpcParams(call)).toEqual({ since: 1, limit: 100 });
    }

    await vi.waitFor(() => {
      for (const invalidate of invalidates) {
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: ["issues", "me/proj"],
        });
      }
    });
    expect(localStorage.getItem("lh_last_event_id")).toBe("7");

    for (const rendered of renders) rendered.unmount();
  });

  it("invalidates git-derived workspace queries after a pull merge event", async () => {
    warmCursor(1);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([ev(7, "pull_request.merged")]))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    render(<HookHarness />, { wrapper: wrapper(client) });

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["workspaces", "me/proj"],
      }),
    );
  });

  it("continues polling after an empty response using the saved cursor", async () => {
    warmCursor(1);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([ev(7)]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([ev(7)]))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);

    render(<HookHarness />, { wrapper: wrapper(new QueryClient()) });

    await vi.waitFor(() =>
      expect(localStorage.getItem("lh_last_event_id")).toBe("7"),
    );
    await vi.advanceTimersByTimeAsync(1500);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(rpcParams(fetchMock.mock.calls[1])).toEqual({
      since: 7,
      limit: 100,
    });
    expect(rpcParams(fetchMock.mock.calls[2])).toEqual({
      since: 0,
      order: "desc",
      limit: 1,
    });

    await vi.advanceTimersByTimeAsync(1500);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(rpcParams(fetchMock.mock.calls[3])).toEqual({
      since: 7,
      limit: 100,
    });
  });

  it("keeps each mounted tab's cursor independent from localStorage writes", async () => {
    warmCursor(1);
    const clients = [new QueryClient(), new QueryClient()];
    const invalidates = clients.map((client) =>
      vi.spyOn(client, "invalidateQueries"),
    );
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      const params = rpcParams(["/rpc", init as RequestInit]);
      const call = fetchMock.mock.calls.length;
      if (call === 1) return Promise.resolve(jsonResponse([ev(7)]));
      if (call === 2) return Promise.resolve(jsonResponse([]));
      if (params.order === "desc")
        return Promise.resolve(jsonResponse([ev(7)]));
      if (params.since === 1) return Promise.resolve(jsonResponse([ev(7)]));
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const renders = clients.map((client) =>
      render(<HookHarness />, { wrapper: wrapper(client) }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(localStorage.getItem("lh_last_event_id")).toBe("7"),
    );
    expect(invalidates[0]).toHaveBeenCalledWith({
      queryKey: ["issues", "me/proj"],
    });
    expect(invalidates[1]).not.toHaveBeenCalledWith({
      queryKey: ["issues", "me/proj"],
    });

    await vi.advanceTimersByTimeAsync(1500);

    await vi.waitFor(() =>
      expect(invalidates[1]).toHaveBeenCalledWith({
        queryKey: ["issues", "me/proj"],
      }),
    );
    expect(fetchMock.mock.calls.slice(2).map(rpcParams)).toEqual(
      expect.arrayContaining([
        { since: 7, limit: 100 },
        { since: 1, limit: 100 },
      ]),
    );

    for (const rendered of renders) rendered.unmount();
  });

  it("resets a too-large cursor when the server's newest event id is lower", async () => {
    localStorage.setItem("lh_last_event_id", "999");
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([ev(12)]));
    vi.stubGlobal("fetch", fetchMock);

    render(<HookHarness />, { wrapper: wrapper(client) });

    await vi.waitFor(() =>
      expect(localStorage.getItem("lh_last_event_id")).toBe("12"),
    );
    expect(rpcParams(fetchMock.mock.calls[0])).toEqual({
      since: 999,
      limit: 100,
    });
    expect(rpcParams(fetchMock.mock.calls[1])).toEqual({
      since: 0,
      order: "desc",
      limit: 1,
    });
    for (const queryKey of [
      ["repo-merge-mode"],
      ["issue-comments"],
      ["pull-debug"],
      ["pull-files"],
      ["pull-reviews"],
      ["pull-review-comments"],
      ["github-pr-status"],
    ]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
  });

  it("does not schedule another poll after unmount", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);

    const rendered = render(<HookHarness />, {
      wrapper: wrapper(new QueryClient()),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rendered.unmount();
    await vi.advanceTimersByTimeAsync(1500);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
