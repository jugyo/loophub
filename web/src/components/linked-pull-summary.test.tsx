import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { HerdrSessions, LinkedPull } from "@/api/types";
import { HOVER_POPUP_DELAY_MS } from "@/lib/use-hover-popover";

const { focusHerdrAgent, sendHerdrAgentInput } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
  sendHerdrAgentInput: vi.fn(),
}));
const herdrSessionsData = vi.hoisted(() => ({
  value: undefined as HerdrSessions | undefined,
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({ data: herdrSessionsData.value }),
  useFocusHerdrAgent: () => ({ mutate: focusHerdrAgent, isPending: false }),
  useSendHerdrAgentInput: () => ({
    mutate: sendHerdrAgentInput,
    isPending: false,
  }),
}));

import { LinkedPullSummaryRow } from "./linked-pull-summary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  focusHerdrAgent.mockClear();
  sendHerdrAgentInput.mockClear();
  herdrSessionsData.value = undefined;
});

function makePull(overrides: Partial<LinkedPull> = {}): LinkedPull {
  return {
    number: 10,
    title: "A PR",
    state: "open",
    merged: false,
    html_url: "/pulls/10",
    github_pull: null,
    cost_stopped: false,
    ...overrides,
  };
}

function renderRow(attemptComparison = false) {
  vi.stubGlobal("fetch", mockRpcFetch({}));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <LinkedPullSummaryRow
        owner="me"
        repo="proj"
        pull={makePull()}
        attemptComparison={attemptComparison}
      />
    ),
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function row() {
  return screen.getByLabelText("Linked PR #10: A PR");
}

function popoverVisible() {
  return screen.queryAllByRole("link", { name: "PR #10" }).length === 2;
}

describe("LinkedPullSummaryRow actions", () => {
  it("uses the standard secondary button colors for Close", async () => {
    renderRow(true);

    const closeButton = await screen.findByRole("button", { name: "Close" });
    expect(closeButton.classList.contains("text-secondary-foreground")).toBe(
      true,
    );
    expect(closeButton.classList.contains("text-destructive")).toBe(false);
    expect(closeButton.classList.contains("hover:text-destructive")).toBe(
      false,
    );
  });
});

describe("LinkedPullSummaryRow popover Agents list (#1493)", () => {
  function herdrWithPullAgent(): HerdrSessions {
    return {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [
            {
              id: "w1:p2",
              name: "dev #10",
              status: "working",
              pull: 10,
              pull_closed: false,
              focusable: true,
            },
          ],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
          issue_workspaces: [],
        },
      ],
    };
  }

  it("shows the sidebar Agents list and opens a pane from its terminal icon", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    herdrSessionsData.value = herdrWithPullAgent();
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.mouseEnter(row());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(popoverVisible()).toBe(true);

    const list = screen.getByRole("list", { name: "Agent hierarchy" });
    expect(within(list).getByText("dev #10")).toBeTruthy();
    fireEvent.click(
      within(list).getByRole("button", { name: "Open in Herdr" }),
    );
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p2" },
      expect.anything(),
    );
  });

  it("omits the Agents list when no live pane resolves to the PR", async () => {
    herdrSessionsData.value = { repos: [] };
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(row());
    expect(popoverVisible()).toBe(true);
    expect(screen.queryByRole("list", { name: "Agent hierarchy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in Herdr" })).toBeNull();
  });
});

describe("LinkedPullSummaryRow hover popover delay", () => {
  it("does not show the popover immediately on hover", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.mouseEnter(row());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS - 1);
    });
    expect(popoverVisible()).toBe(false);
  });

  it("shows the popover once the hover delay elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.mouseEnter(row());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(popoverVisible()).toBe(true);
    expect(screen.queryByRole("link", { name: "Open PR #10" })).toBeNull();

    const [, headerLink] = screen.getAllByRole("link", { name: "PR #10" });
    expect(headerLink.getAttribute("href")).toBe("/r/me/proj/pulls/10");
  });

  it("cancels the pending popover when the pointer leaves during the delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.mouseEnter(row());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS - 1);
    });
    fireEvent.mouseLeave(row());
    // Advancing well past the original delay must never flash the popover open.
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS * 2);
    });
    expect(popoverVisible()).toBe(false);
  });

  it("opens immediately on keyboard focus without any delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(row());
    expect(popoverVisible()).toBe(true);
  });

  it("keeps the popover open while keyboard focus moves to its header link", async () => {
    renderRow();
    const trigger = await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(trigger);
    const [, headerLink] = screen.getAllByRole("link", { name: "PR #10" });
    fireEvent.blur(trigger, { relatedTarget: headerLink });
    act(() => headerLink.focus());

    expect(popoverVisible()).toBe(true);
    expect(document.activeElement).toBe(headerLink);
  });

  it("closes on Escape", async () => {
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(row());
    expect(popoverVisible()).toBe(true);
    fireEvent.keyDown(row(), { key: "Escape" });
    expect(popoverVisible()).toBe(false);
  });

  it("closes on blur to an element outside the row", async () => {
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(row());
    expect(popoverVisible()).toBe(true);
    fireEvent.blur(row(), { relatedTarget: document.body });
    expect(popoverVisible()).toBe(false);
  });
});
