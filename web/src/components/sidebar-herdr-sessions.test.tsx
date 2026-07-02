import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "terminal/sessions": () => result,
      "terminal/agentRead": (p) =>
        typeof agentRead === "function"
          ? agentRead(p)
          : (agentRead ?? { output: null }),
      ...extraHandlers,
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
                {
                  id: `${String.fromCharCode(0)}idx:0`,
                  name: "dev #11",
                  status: "working",
                },
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

    it("stays open when the pointer moves from the row onto the preview, and closes on leaving the preview", async () => {
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

      const row = agentRow();
      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      const tooltip = await screen.findByRole("tooltip");

      // Pointer leaves the row on its way to the preview — this must not hide it
      // immediately (#523), since the two elements don't overlap on screen.
      fireEvent.mouseLeave(row);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(screen.queryByRole("tooltip")).toBeTruthy();

      fireEvent.mouseEnter(tooltip);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByRole("tooltip")).toBeTruthy();

      fireEvent.mouseLeave(tooltip);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("renders the preview as a DOM sibling of the row, not a descendant (#523 round 2)", async () => {
      // Real-browser mouseenter/mouseleave firing is DOM-ancestry-aware: nesting the
      // (visually detached, `position: fixed`) preview inside the row let the browser
      // treat the pointer as never leaving the row while it sat over the preview, so the
      // row's onMouseEnter failed to re-fire on the way back and the popup could close
      // while the pointer was still on the row. jsdom's fireEvent bypasses real
      // hit-testing, so it can't reproduce that bug directly — this asserts the DOM
      // structure the fix depends on instead.
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

      const row = agentRow();
      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      const tooltip = await screen.findByRole("tooltip");

      expect(row.contains(tooltip)).toBe(false);
      expect(tooltip.parentElement).toBe(row.parentElement);
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

  // #521: kill button.
  const ONE_AGENT: HerdrSessions = {
    repos: [
      {
        repo: "me/app",
        session_name: "me-app-12345678",
        agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
      },
    ],
  };

  it("gates the kill button behind a confirm dialog and closes the pane on confirm", async () => {
    renderWithSessions(ONE_AGENT, undefined, {
      "terminal/killAgent": () => ({ ok: true }),
    });

    // Not visible until the kill button is clicked.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Close dev #11's pane" }),
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close pane" }));

    await waitFor(() => {
      const call = rpcCall("terminal/killAgent");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ repo: "me/app", paneId: "w1:p1" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancels without calling killAgent", async () => {
    renderWithSessions(ONE_AGENT, undefined, {
      "terminal/killAgent": () => ({ ok: true }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Close dev #11's pane" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rpcCall("terminal/killAgent")).toBeUndefined();
  });

  it("keeps the dialog open and shows the error when the kill fails (#521 AC: no silent failure)", async () => {
    renderWithSessions(ONE_AGENT, undefined, {
      "terminal/killAgent": () => {
        throw new RpcFault(422, "herdr command not found on PATH");
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Close dev #11's pane" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close pane" }));

    expect(
      await screen.findByText(/herdr command not found on PATH/),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not show a stale error from a previous failed attempt when the dialog reopens", async () => {
    renderWithSessions(ONE_AGENT, undefined, {
      "terminal/killAgent": () => {
        throw new RpcFault(422, "herdr command not found on PATH");
      },
    });

    const killButton = await screen.findByRole("button", {
      name: "Close dev #11's pane",
    });
    fireEvent.click(killButton);
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close pane" }));
    await screen.findByText(/herdr command not found on PATH/);

    // Cancel, then reopen — the dialog must start clean, not show the previous failure.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(killButton);
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).queryByText(/herdr command not found on PATH/),
    ).toBeNull();
  });
});
