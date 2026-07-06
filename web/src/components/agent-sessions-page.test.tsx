import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { AgentSession } from "@/api/types";
import {
  AgentSessionsPage,
  formatCost,
  formatTokenCount,
} from "./agent-sessions-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SESSIONS: AgentSession[] = [
  {
    id: "s-old",
    agent: "reviewer",
    created_at: "2026-07-03T10:00:00Z",
    updated_at: "2026-07-03T12:00:00Z",
  },
  {
    id: "s-new",
    agent: "lh-dev",
    session: "s-new",
    name: "dev #725",
    runtime: "codex",
    kind: "dev",
    created_at: "2026-07-04T10:00:00Z",
    updated_at: "2026-07-04T12:00:00Z",
    usage: [
      {
        session_id: "s-new",
        model: "gpt-5.5",
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
        output_tokens: 400,
        cost_usd: 0.0123,
        updated_at: "2026-07-04T12:00:00Z",
      },
      {
        session_id: "s-new",
        model: "gpt-5-mini",
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
        output_tokens: 30,
        cost_usd: 0.001,
        updated_at: "2026-07-04T12:00:00Z",
      },
    ],
    subagent_usage: [
      {
        session_id: "s-new",
        source_id: "subagent-thread",
        parent_source_id: "root-thread",
        label: "Security reviewer",
        kind: "codex-child-rollout",
        model: "gpt-5.5",
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 200,
        output_tokens: 50,
        cost_usd: 0.002,
        updated_at: "2026-07-04T12:00:00Z",
      },
    ],
    linked_targets: [
      {
        repo: "jugyo/loophub",
        kind: "issue",
        number: 725,
        title: "Sessions page",
        state: "open",
      },
      {
        repo: "ju gyo/loop#hub",
        kind: "pull",
        number: 735,
        title: "Implement sessions page",
        state: "open",
      },
    ],
  },
];

function renderPage(sessions: AgentSession[] = SESSIONS) {
  vi.stubGlobal("fetch", mockRpcFetch({ "sessions/list": () => sessions }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/stats/sessions",
    component: AgentSessionsPage,
  });
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([sessionsRoute, issueRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/stats/sessions"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("formatTokenCount", () => {
  it("formats token counts with grouping", () => {
    expect(formatTokenCount(1234567)).toBe("1,234,567");
  });
});

describe("formatCost", () => {
  it("formats known and unknown costs", () => {
    expect(formatCost(null)).toBe("n/a");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.0123)).toBe("$0.01");
  });
});

describe("AgentSessionsPage", () => {
  it("uses the full available page width", async () => {
    renderPage();

    const root = (
      await screen.findByRole("heading", { name: "Agent sessions" })
    ).closest("div");
    expect(root?.className).toContain("w-full");
    expect(root?.className).not.toContain("max-w-content");
    expect(root?.className).not.toContain("mx-auto");
  });

  it("shows sessions by updated time with usage totals, cost, and linked work", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-04T13:00:00Z").getTime(),
    );
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Agent sessions" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: "Session id" }),
    ).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("dev #725")).toBeTruthy();
    expect(within(rows[1]).getByText("s-new")).toBeTruthy();
    expect(within(rows[1]).getByText("gpt-5.5, gpt-5-mini")).toBeTruthy();
    expect(within(rows[1]).getByText("1,010")).toBeTruthy();
    expect(within(rows[1]).getByText("200")).toBeTruthy();
    expect(within(rows[1]).getByText("3,020")).toBeTruthy();
    expect(within(rows[1]).getByText("430")).toBeTruthy();
    expect(within(rows[1]).getByText("4,660")).toBeTruthy();
    expect(within(rows[1]).getByText("$0.01")).toBeTruthy();
    expect(within(rows[1]).getByText("Security reviewer")).toBeTruthy();
    expect(
      within(rows[1]).getByText("in 100 · cw 0 · cr 200 · out 50"),
    ).toBeTruthy();
    expect(within(rows[1]).getByText("350 · $0.0020")).toBeTruthy();
    expect(within(rows[1]).getByTitle("2026-07-04T12:00:00Z").textContent).toBe(
      "1h ago",
    );

    const issue = within(rows[1]).getByRole("link", { name: "Issue #725" });
    expect(issue.getAttribute("href")).toBe("/r/jugyo/loophub/issues/725");
    const pull = within(rows[1]).getByRole("link", { name: "PR #735" });
    expect(pull.getAttribute("href")).toBe("/r/ju%20gyo/loop%23hub/pulls/735");

    expect(within(rows[2]).getAllByText("reviewer")).toHaveLength(2);
    expect(within(rows[2]).getAllByRole("cell")[1].textContent).toBe("");
    expect(within(rows[2]).getAllByText("n/a").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(within(rows[2]).getByTitle("2026-07-03T12:00:00Z").textContent).toBe(
      "1d ago",
    );
    expect(within(rows[2]).queryByText("0")).toBeNull();
  });

  it("shows an empty state", async () => {
    renderPage([]);
    expect(await screen.findByText("No agent sessions.")).toBeTruthy();
  });
});
