import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { HerdrAgentRead, HerdrSessions } from "@/api/types";
import { SidebarHerdrSessions } from "./sidebar-herdr-sessions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderWithSessions(
  result: HerdrSessions,
  agentRead?: HerdrAgentRead | ((params: any) => HerdrAgentRead),
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "terminal/sessions": () => result,
      "terminal/agentRead": (p) =>
        typeof agentRead === "function"
          ? agentRead(p)
          : (agentRead ?? { output: null }),
    }),
  );
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

  describe("hover preview (#500)", () => {
    function agentRow() {
      return screen.getByText("dev #11").parentElement as HTMLElement;
    }

    it("shows the preview after the hover debounce elapses", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n" },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe("$ npm test\n42 passing\n");
      // Prefers the pane id (agent.id) over the display name so two label-less
      // agents sharing a name can't be misattributed — see agentReadTarget.
      expect(rpcCall("terminal/agentRead")?.params).toEqual({
        repo: "me/app",
        target: "w1:p1",
      });
    });

    it("falls back to the display name when the agent has no real pane id", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              // The synthetic idx: id (no pane_id from herdr) — see core/herdr-status.ts.
              agents: [
                { id: "\u0000idx:0", name: "dev #11", status: "working" },
              ],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n" },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      await screen.findByRole("tooltip");
      expect(rpcCall("terminal/agentRead")?.params).toEqual({
        repo: "me/app",
        target: "dev #11",
      });
    });

    it("does not fetch a preview when the pointer leaves before the debounce elapses", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
            },
          ],
        },
        { output: "should not appear" },
      );
      await screen.findByText("dev #11");

      const row = agentRow();
      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.mouseLeave(row);
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(screen.queryByText("should not appear")).toBeNull();
      expect(rpcCall("terminal/agentRead")).toBeUndefined();
    });

    it("shows nothing when the agent has no output (herdr down / agent gone)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
            },
          ],
        },
        { output: null },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => expect(rpcCall("terminal/agentRead")).toBeDefined());
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });
});
