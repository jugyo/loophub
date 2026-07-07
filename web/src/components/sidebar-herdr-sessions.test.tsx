import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { HerdrAgentRead, HerdrSessions } from "@/api/types";
import {
  agentPreviewFit,
  isVisibleSidebarAgent,
  SidebarHerdrSessions,
  sortAgents,
} from "./sidebar-herdr-sessions";

// ToastProvider reads the router (useRouterState) to dismiss on navigation, which isn't
// mounted here — mock useToast to a spy so the focus-error path can be asserted without a
// router. Only the focus button uses it.
const { showError } = vi.hoisted(() => ({ showError: vi.fn() }));
vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError, showSuccess: vi.fn() }),
}));

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
          : (agentRead ?? { output: null, cols: null, rows: null }),
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

function stubPreviewNaturalSize(width = 320, height = 64) {
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.tagName === "PRE" ? width : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.tagName === "PRE" ? height : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.tagName === "PRE") {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: height,
          width,
          height,
          toJSON: () => ({}),
        };
      }
      return getBoundingClientRect.call(this);
    },
  );
}

describe("agentPreviewFit", () => {
  it("keeps content at 1x when it already fits", () => {
    expect(agentPreviewFit(320, 80, 640, 480)).toMatchObject({
      scale: 1,
      width: 338,
      maxHeight: 98,
      contentWidth: 320,
      contentHeight: 80,
      needsHorizontalScroll: false,
    });
  });

  it("scales wide content into the popup without a rounding overflow", () => {
    const fit = agentPreviewFit(900, 240, 614.4, 537.6);
    expect(fit.scale).toBeLessThan(1);
    expect(fit.scale).toBeGreaterThan(0.4);
    expect(fit.width).toBeLessThanOrEqual(614.4);
    expect(fit.needsHorizontalScroll).toBe(false);
  });

  it("reserves border-box border space when fitting exactly to max width", () => {
    const fit = agentPreviewFit(596, 120, 614, 400);
    expect(fit.scale).toBe(1);
    expect(fit.width).toBe(614);
    expect(fit.contentWidth).toBe(596);
    expect(fit.needsHorizontalScroll).toBe(false);
  });

  it("does not scale down narrow panes solely because they are tall", () => {
    const fit = agentPreviewFit(320, 1200, 640, 480);
    expect(fit.scale).toBe(1);
    expect(fit.width).toBe(338);
    expect(fit.maxHeight).toBe(480);
    expect(fit.needsHorizontalScroll).toBe(false);
  });

  it("clamps extreme panes to the scale floor and leaves horizontal scrolling", () => {
    const fit = agentPreviewFit(4000, 120, 614.4, 537.6);
    expect(fit.scale).toBe(0.4);
    expect(fit.width).toBe(614.4);
    expect(fit.contentWidth).toBe(1600);
    expect(fit.needsHorizontalScroll).toBe(true);
  });
});

describe("SidebarHerdrSessions", () => {
  function rowForAgent(name: string): HTMLElement {
    return screen.getByText(name).parentElement as HTMLElement;
  }

  function statusInRow(name: string, status: string): HTMLElement {
    const row = rowForAgent(name);
    const statusEl = Array.from(row.querySelectorAll("span")).find(
      (el) => el.textContent === status,
    );
    if (!statusEl) throw new Error(`Status ${status} not found for ${name}`);
    return statusEl;
  }

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
          pull_workspaces: [],
        },
        {
          repo: "me/other",
          session_name: "me-other-87654321",
          agents: [{ id: "w2:p1", name: "dev #2", status: "idle" }],
          pull_workspaces: [],
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

  it("uses a robot icon and colors status text with the agent status mapping", async () => {
    renderWithSessions({
      repos: [
        {
          repo: "me/app",
          session_name: "me-app-12345678",
          agents: [
            { id: "w1:p1", name: "blocked agent", status: "blocked" },
            { id: "w1:p2", name: "working agent", status: "working" },
            { id: "w1:p3", name: "done agent", status: "done" },
            { id: "w1:p4", name: "idle agent", status: "idle", pull: 4 },
            { id: "w1:p5", name: "unknown agent", status: "paused" },
          ],
          pull_workspaces: [],
        },
      ],
    });

    await screen.findByText("blocked agent");

    const row = rowForAgent("blocked agent");
    expect(row.querySelector(".lucide-bot")).toBeTruthy();
    expect(row.querySelector(".rounded-full")).toBeNull();
    expect(statusInRow("blocked agent", "blocked").className).toContain(
      "text-red-500",
    );
    expect(statusInRow("working agent", "working").className).toContain(
      "text-yellow-500",
    );
    expect(statusInRow("done agent", "done").className).toContain(
      "text-blue-500",
    );
    expect(statusInRow("idle agent", "idle").className).toContain(
      "text-green-500",
    );
    expect(statusInRow("unknown agent", "paused").className).toContain(
      "text-muted-foreground",
    );
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
    beforeEach(() => {
      stubPreviewNaturalSize();
    });

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
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: null, rows: null },
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

    it("keeps narrow measured content at 1x instead of enlarging it", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: 80, rows: 20 },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.style.width).toBe("338px");
      expect(tooltip.style.maxHeight).toBe("82px");
      const pre = tooltip.querySelector("pre");
      expect(pre?.style.display).toBe("inline-block");
      expect(pre?.style.transform).toBe("scale(1)");
    });

    it("scales wide measured content to fit the viewport-relative popup width", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      stubPreviewNaturalSize(900, 240);
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
              pull_workspaces: [],
            },
          ],
        },
        // A common wide/tall terminal pane. Previously (#536) this drove the popup's
        // width up to the viewport-relative ceiling to avoid `whitespace-pre-wrap`
        // re-wrapping every long line; now the `pre` scrolls horizontally instead
        // (#548), so only the height still tracks the pane (via rows).
        { output: "$ npm test\n42 passing\n", cols: 239, rows: 85 },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const tooltip = await screen.findByRole("tooltip");
      expect(Number.parseFloat(tooltip.style.width)).toBeLessThanOrEqual(
        1024 * 0.6,
      );
      expect(tooltip.querySelector("pre")?.style.transform).toContain("scale(");
      expect(tooltip.querySelector("pre")?.style.transform).not.toBe(
        "scale(1)",
      );
    });

    it("lets the preview scroll horizontally instead of wrapping long lines (#548)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: 239, rows: 85 },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.className).toContain("overflow-x-auto");
      const pre = tooltip.querySelector("pre");
      expect(pre?.style.transform).toBe("scale(1)");
      expect(pre?.className).toContain("whitespace-pre");
      expect(pre?.className).not.toContain("whitespace-pre-wrap");
      expect(pre?.className).not.toContain("break-words");
    });

    it("clips the transformed child so floor-mode scroll range follows scaled width", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      stubPreviewNaturalSize(4000, 120);
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: 400, rows: 10 },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const tooltip = await screen.findByRole("tooltip");
      const scaledSlot = tooltip.querySelector("pre")?.parentElement;
      expect(scaledSlot?.style.overflow).toBe("hidden");
      expect(Number.parseFloat(scaledSlot?.style.width ?? "0")).toBe(1600);
      expect(tooltip.querySelector("pre")?.style.transform).toBe("scale(0.4)");
    });

    it("falls back to a fixed popup size when herdr didn't report pane dimensions (#531 AC)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: null, rows: null },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.style.width).toBe("338px");
      expect(tooltip.style.maxHeight).toBe("82px");
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
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: null, rows: null },
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
              pull_workspaces: [],
            },
          ],
        },
        { output: "should not appear", cols: null, rows: null },
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
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: null, rows: null },
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
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: null, rows: null },
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

    it("renders SGR color codes as colored HTML (#554)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
              pull_workspaces: [],
            },
          ],
        },
        // core/herdr-status.ts keeps SGR sequences in `output` (#554); the raw green
        // color code must never leak into the rendered text as literal garbage.
        { output: "\x1b[32mPASS\x1b[0m npm test\n", cols: null, rows: null },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.querySelector('[style*="color"]')?.textContent).toBe(
        "PASS",
      );
      expect(tooltip.textContent).toBe("PASS npm test\n");
      expect(tooltip.textContent).not.toContain("\x1b");
    });

    it("still renders plain-text output with no ANSI unchanged (no regression)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
              pull_workspaces: [],
            },
          ],
        },
        { output: "$ npm test\n42 passing\n", cols: null, rows: null },
      );
      await screen.findByText("dev #11");

      fireEvent.mouseEnter(agentRow());
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe("$ npm test\n42 passing\n");
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
              pull_workspaces: [],
            },
          ],
        },
        { output: null, cols: null, rows: null },
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

  // #617: terminal icon per row that focuses the agent's herdr pane.
  describe("focus button (#617)", () => {
    const RUNNING: HerdrSessions = {
      repos: [
        {
          repo: "me/app",
          session_name: "me-app-12345678",
          agents: [{ id: "w1:p1", name: "dev #11", status: "working" }],
          pull_workspaces: [],
        },
      ],
    };

    it("focuses the agent's pane via terminal/focusAgent when the icon is clicked", async () => {
      renderWithSessions(RUNNING, undefined, {
        "terminal/focusAgent": () => ({ ok: true }),
      });

      fireEvent.click(
        await screen.findByRole("button", { name: "Focus dev #11's pane" }),
      );

      await waitFor(() => {
        expect(rpcCall("terminal/focusAgent")?.params).toEqual({
          repo: "me/app",
          paneId: "w1:p1",
        });
      });
    });

    it("renders the row full-width and overlays hover actions outside normal layout", async () => {
      renderWithSessions(RUNNING);

      const button = await screen.findByRole("button", {
        name: "Focus dev #11's pane",
      });
      const row = rowForAgent("dev #11");

      expect(row.className).toContain("relative");
      expect(row.className).toContain("w-full");
      expect(button.parentElement?.className).toContain("absolute");
      expect(button.parentElement?.className).toContain("right-2");
    });

    it("hides the focus icon for a synthetic-id agent that has no real pane (#617 AC)", async () => {
      renderWithSessions({
        repos: [
          {
            repo: "me/app",
            session_name: "me-app-12345678",
            agents: [
              {
                id: `${String.fromCharCode(0)}idx:0`,
                name: "dev #11",
                status: "working",
                // Stale so the kill button renders (#621) — this test asserts the kill
                // button still shows while only the focus icon is withheld.
                pull_closed: true,
              },
            ],
            pull_workspaces: [],
          },
        ],
      });

      // The row (and its kill button) still render; only the focus icon is withheld.
      await screen.findByText("dev #11");
      expect(
        screen.getByRole("button", { name: "Close dev #11's pane" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Focus dev #11's pane" }),
      ).toBeNull();
    });

    it("keeps status visible on hover-capable rows that have no overlay actions", async () => {
      renderWithSessions({
        repos: [
          {
            repo: "me/app",
            session_name: "me-app-12345678",
            agents: [
              {
                id: `${String.fromCharCode(0)}idx:0`,
                name: "dev #11",
                status: "working",
              },
            ],
            pull_workspaces: [],
          },
        ],
      });

      await screen.findByText("dev #11");

      expect(
        screen.queryByRole("button", { name: "Focus dev #11's pane" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Close dev #11's pane" }),
      ).toBeNull();
      expect(statusInRow("dev #11", "working").className).not.toContain(
        "group-hover:opacity-0",
      );
    });

    it("surfaces a toast when focusing fails (#617 AC)", async () => {
      showError.mockClear();
      renderWithSessions(RUNNING, undefined, {
        "terminal/focusAgent": () => {
          throw new RpcFault(422, "herdr command not found on PATH");
        },
      });

      fireEvent.click(
        await screen.findByRole("button", { name: "Focus dev #11's pane" }),
      );

      await waitFor(() => {
        expect(showError).toHaveBeenCalledWith(
          expect.stringMatching(/herdr command not found on PATH/),
        );
      });
    });
  });

  // #611: agents whose worktree PR is merged/closed render muted.
  describe("stale agents (#611)", () => {
    const MIXED: HerdrSessions = {
      repos: [
        {
          repo: "me/app",
          session_name: "me-app-12345678",
          agents: [
            {
              id: "w1:p1",
              name: "dev #11",
              status: "working",
              pull_closed: true,
            },
            { id: "w1:p2", name: "dev #13", status: "working" },
          ],
          pull_workspaces: [],
        },
      ],
    };

    it("grays out the row when the agent's PR is merged/closed, leaving others unchanged", async () => {
      renderWithSessions(MIXED);

      const staleName = await screen.findByText("dev #11");
      expect(staleName.className).toContain("text-muted-foreground");
      expect(staleName.className).toContain("opacity-60");
      const staleStatus = statusInRow("dev #11", "working");
      expect(staleStatus.className).toContain("text-muted-foreground");
      expect(staleStatus.className).not.toContain("text-yellow-500");
      // The icon fades too (#678), applied on itself rather than the row so it
      // doesn't compound onto the Focus/Kill button overlay in the same row.
      expect(
        rowForAgent("dev #11").querySelector(".lucide-bot")?.className,
      ).toContain("opacity-60");

      const freshName = screen.getByText("dev #13");
      expect(freshName.className).not.toContain("text-muted-foreground");
      expect(freshName.className).not.toContain("opacity-60");
      expect(statusInRow("dev #13", "working").className).toContain(
        "text-yellow-500",
      );
      expect(
        rowForAgent("dev #13").querySelector(".lucide-bot")?.className,
      ).not.toContain("opacity-60");
    });

    // #620/#645: stale rows sink to the bottom of their repo group so active agents stay on top.
    it("orders stale agents after active ones within each repo group, stably (#620, #645)", async () => {
      renderWithSessions({
        repos: [
          {
            repo: "me/app",
            session_name: "me-app-12345678",
            agents: [
              // Interleaved active/stale, with both stale cases: a closed PR and a
              // no-PR idle New issue agent. This proves the partition (stale below
              // active) and stable order within each partition.
              {
                id: "w1:p1",
                name: "app closed stale",
                status: "done",
                pull_closed: true,
              },
              { id: "w1:p2", name: "app active A", status: "working" },
              {
                id: "w1:p3",
                name: "app no-PR idle stale",
                status: "idle",
                pull: null,
              },
              { id: "w1:p4", name: "app active B", status: "blocked" },
            ],
            pull_workspaces: [],
          },
          {
            repo: "me/other",
            session_name: "me-other-87654321",
            agents: [
              { id: "w2:p1", name: "other active", status: "working" },
              {
                id: "w2:p2",
                name: "other stale",
                status: "done",
                pull_closed: true,
              },
            ],
            pull_workspaces: [],
          },
        ],
      });

      await screen.findByText("app active A");

      // Rows carry text-sm; the group repo labels don't — collect only agent rows so the
      // asserted order is agents, not repo headers.
      const names = Array.from(
        document.querySelectorAll<HTMLElement>("div.text-sm"),
      ).map((row) => row.querySelector("span:nth-child(2)")?.textContent);

      // me/app: actives keep their relative order, then stales keep theirs — reordering
      // stays inside the group, and me/other's rows follow me/app's without interleaving.
      expect(names).toEqual([
        "app active A",
        "app active B",
        "app closed stale",
        "app no-PR idle stale",
        "other active",
        "other stale",
      ]);
    });

    it("sortAgents is a stable partition that leaves the input untouched (#620, #645)", () => {
      const agents = [
        { id: "a", name: "closed stale", status: "done", pull_closed: true },
        { id: "b", name: "active 1", status: "working" },
        { id: "c", name: "idle PR-linked active", status: "idle", pull: 11 },
        { id: "d", name: "no-PR idle stale", status: "idle", pull: null },
      ];
      const sorted = sortAgents(agents);
      expect(sorted.map((a) => a.id)).toEqual(["b", "c", "a", "d"]);
      // Non-mutating: the react-query cache array must not be reordered in place.
      expect(agents.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("keeps the hover preview and kill button working on a grayed-out row (#611 AC)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      stubPreviewNaturalSize();
      renderWithSessions(
        MIXED,
        { output: "$ npm test\n42 passing\n", cols: null, rows: null },
        { "terminal/killAgent": () => ({ ok: true }) },
      );

      const row = (await screen.findByText("dev #11"))
        .parentElement as HTMLElement;
      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe("$ npm test\n42 passing\n");

      // Immediate kill, no confirm dialog (#621).
      fireEvent.click(
        screen.getByRole("button", { name: "Close dev #11's pane" }),
      );
      await waitFor(() => {
        expect(rpcCall("terminal/killAgent")?.params).toMatchObject({
          repo: "me/app",
          paneId: "w1:p1",
        });
      });
    });
  });

  // #621: the kill button is shown only on stale (PR merged/closed) rows, kills immediately
  // with no confirm dialog, and surfaces failures via a toast instead of a dialog.
  describe("kill button (#621)", () => {
    // One stale agent (kill button shown) and one active agent (no kill button).
    const STALE_AND_ACTIVE: HerdrSessions = {
      repos: [
        {
          repo: "me/app",
          session_name: "me-app-12345678",
          agents: [
            {
              id: "w1:p1",
              name: "dev #11",
              status: "working",
              pull_closed: true,
            },
            // Active: pull_closed omitted / false — no linked closed PR.
            { id: "w1:p2", name: "dev #13", status: "working" },
          ],
          pull_workspaces: [],
        },
      ],
    };

    it("shows the kill button only on stale rows, not active ones (#621 AC)", async () => {
      renderWithSessions(STALE_AND_ACTIVE);

      await screen.findByText("dev #11");
      // Stale row → kill button present.
      expect(
        screen.getByRole("button", { name: "Close dev #11's pane" }),
      ).toBeTruthy();
      // Active row → no kill button.
      expect(
        screen.queryByRole("button", { name: "Close dev #13's pane" }),
      ).toBeNull();
    });

    it("kills the pane immediately without a confirm dialog when clicked (#621 AC)", async () => {
      renderWithSessions(STALE_AND_ACTIVE, undefined, {
        "terminal/killAgent": () => ({ ok: true }),
      });

      fireEvent.click(
        await screen.findByRole("button", { name: "Close dev #11's pane" }),
      );

      await waitFor(() => {
        const call = rpcCall("terminal/killAgent");
        expect(call).toBeTruthy();
        expect(call!.params).toMatchObject({ repo: "me/app", paneId: "w1:p1" });
      });
      // No confirm dialog is ever shown — the click kills directly.
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("surfaces a toast when the kill fails, with no dialog (#621 AC)", async () => {
      showError.mockClear();
      renderWithSessions(STALE_AND_ACTIVE, undefined, {
        "terminal/killAgent": () => {
          throw new RpcFault(422, "herdr command not found on PATH");
        },
      });

      fireEvent.click(
        await screen.findByRole("button", { name: "Close dev #11's pane" }),
      );

      await waitFor(() => {
        expect(showError).toHaveBeenCalledWith(
          expect.stringMatching(/herdr command not found on PATH/),
        );
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("no-PR agents", () => {
    it("hides New issue agents from the global Agents list", async () => {
      renderWithSessions({
        repos: [
          {
            repo: "me/app",
            session_name: "me-app-12345678",
            agents: [
              {
                id: "w1:p1",
                name: "New issue - 12345678",
                status: "working",
                pull: null,
              },
            ],
            pull_workspaces: [],
          },
        ],
      });

      await waitFor(() => expect(screen.queryByText("Agents")).toBeNull());
      expect(screen.queryByText("New issue - 12345678")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Close New issue/ }),
      ).toBeNull();
    });

    it("keeps a non-New issue no-PR agent visible while it is not idle", async () => {
      renderWithSessions({
        repos: [
          {
            repo: "me/app",
            session_name: "me-app-12345678",
            agents: [
              {
                id: "w1:p1",
                name: "repo shell",
                status: "working",
                pull: null,
              },
            ],
            pull_workspaces: [],
          },
        ],
      });

      const name = await screen.findByText("repo shell");
      expect(name.className).not.toContain("text-muted-foreground");
      expect(statusInRow("repo shell", "working").className).toContain(
        "text-yellow-500",
      );
      expect(
        screen.queryByRole("button", { name: "Close repo shell's pane" }),
      ).toBeNull();
    });

    it("leaves an idle PR-linked agent with an open PR a normal row (pull_closed logic unchanged)", async () => {
      renderWithSessions({
        repos: [
          {
            repo: "me/app",
            session_name: "me-app-12345678",
            // Open PR: pull is a number and pull_closed is false, even though idle.
            agents: [
              {
                id: "w1:p1",
                name: "dev #11",
                status: "idle",
                pull: 11,
                pull_closed: false,
              },
            ],
            pull_workspaces: [],
          },
        ],
      });

      const name = await screen.findByText("dev #11");
      expect(name.className).not.toContain("text-muted-foreground");
      expect(statusInRow("dev #11", "idle").className).toContain(
        "text-green-500",
      );
      expect(
        screen.queryByRole("button", { name: "Close dev #11's pane" }),
      ).toBeNull();
    });

    it("kills a non-New issue no-PR idle agent's pane when its kill button is clicked", async () => {
      renderWithSessions(
        {
          repos: [
            {
              repo: "me/app",
              session_name: "me-app-12345678",
              agents: [
                { id: "w1:p1", name: "repo shell", status: "idle", pull: null },
              ],
              pull_workspaces: [],
            },
          ],
        },
        undefined,
        { "terminal/killAgent": () => ({ ok: true }) },
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "Close repo shell's pane" }),
      );

      await waitFor(() => {
        expect(rpcCall("terminal/killAgent")?.params).toMatchObject({
          repo: "me/app",
          paneId: "w1:p1",
        });
      });
    });

    it("classifies only New issue-shaped no-PR labels as hidden", () => {
      expect(
        isVisibleSidebarAgent({
          id: "w1:p1",
          name: "New issue (me/app)",
          status: "working",
          pull: null,
        }),
      ).toBe(false);
      expect(
        isVisibleSidebarAgent({
          id: "w1:p2",
          name: "New issue - 12345678",
          status: "working",
          pull: null,
        }),
      ).toBe(false);
      expect(
        isVisibleSidebarAgent({
          id: "w1:p3",
          name: "New issue - 12345678",
          status: "working",
          pull: 12,
        }),
      ).toBe(true);
      expect(
        isVisibleSidebarAgent({
          id: "w1:p4",
          name: "repo shell",
          status: "working",
          pull: null,
        }),
      ).toBe(true);
    });
  });
});
