import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault } from "@/api/rpc-mock";
import type { HerdrSessions } from "@/api/types";
import { SidebarHerdrSessions } from "./sidebar-herdr-sessions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithSessions(result: HerdrSessions) {
  vi.stubGlobal("fetch", mockRpcFetch({ "terminal/sessions": () => result }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SidebarHerdrSessions />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("SidebarHerdrSessions", () => {
  it("renders agent names and statuses grouped by repo", async () => {
    renderWithSessions({
      repos: [
        {
          repo: "me/app",
          session_name: "me-app-12345678",
          agents: [
            { id: "w1:p1", name: "dev #11", status: "working" },
            { id: "w1:p2", name: "dev #13", status: "blocked" },
          ],
        },
        {
          repo: "me/other",
          session_name: "me-other-87654321",
          agents: [{ id: "w2:p1", name: "dev #2", status: "idle" }],
        },
      ],
    });

    expect(await screen.findByText("Agents")).toBeTruthy();
    expect(screen.getByText("me/app")).toBeTruthy();
    expect(screen.getByText("me/other")).toBeTruthy();
    expect(screen.getByText("dev #11")).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("dev #13")).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(screen.getByText("dev #2")).toBeTruthy();
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("renders nothing when no sessions are running", async () => {
    const { container, queryClient } = renderWithSessions({ repos: [] });
    // Wait for the query to actually settle so this asserts the post-fetch render,
    // not the (also empty) loading state.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("Agents")).toBeNull();
  });

  it("renders nothing when the query errors", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "terminal/sessions": () => {
          throw new RpcFault(500, "boom");
        },
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SidebarHerdrSessions />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(container.innerHTML).toBe("");
  });
});
