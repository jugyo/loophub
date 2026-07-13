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
  return screen.queryByRole("link", { name: /Open PR #10/ }) !== null;
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
