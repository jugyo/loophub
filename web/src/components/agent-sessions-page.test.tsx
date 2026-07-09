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
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { AgentSession } from "@/api/types";
import { usageTotal } from "@/lib/session-usage";
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
    session: "",
    created_at: "2026-07-03T10:00:00Z",
    updated_at: "2026-07-03T12:00:00Z",
  },
  {
    id: "s-new",
    agent: "lh-build",
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
        context_usage_percent: 20,
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
        context_usage_percent: 35,
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
        context_usage_percent: null,
        updated_at: "2026-07-04T12:00:00Z",
      },
      {
        session_id: "s-new",
        source_id: "old-subagent-thread",
        parent_source_id: "root-thread",
        label: "Old reviewer",
        kind: "codex-child-rollout",
        model: "gpt-5.5",
        input_tokens: 999,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 999,
        output_tokens: 999,
        cost_usd: 9,
        context_usage_percent: null,
        updated_at: "2026-05-04T12:00:00Z",
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

describe("usageTotal", () => {
  it("preserves the max context usage percent", () => {
    expect(usageTotal(SESSIONS[1].usage).context_usage_percent).toBe(35);
    expect(usageTotal(undefined).context_usage_percent).toBeNull();
  });
});

describe("AgentSessionsPage", () => {
  it("uses the full available page width", async () => {
    renderPage();

    const root = (
      await screen.findByRole("heading", { name: "Agent sessions" })
    ).closest("[class*='w-full']");
    expect(root?.className).toContain("w-full");
    expect(root?.className).not.toContain("max-w-content");
    expect(root?.className).not.toContain("mx-auto");
  });

  it("shows sessions in the selected period by cost with usage totals and linked work", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-04T13:00:00Z").getTime(),
    );
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Agent sessions" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "last 1 month" })).toBeTruthy();
    expect(screen.getByLabelText("Total cost trend")).toBeTruthy();
    expect(screen.getByText("Sorted by cost desc")).toBeTruthy();
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
    expect(within(rows[1]).queryByText("Old reviewer")).toBeNull();
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

    expect(screen.queryByText("s-old")).toBeNull();
  });

  it("filters by preset range and switches granularity and chart mode", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-09T13:00:00Z").getTime(),
    );
    renderPage([
      {
        id: "today-codex",
        agent: "lh-build",
        session: "today-codex",
        runtime: "codex",
        created_at: "2026-07-09T08:00:00Z",
        updated_at: "2026-07-09T09:00:00Z",
        usage: [
          {
            session_id: "today-codex",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.02,
            context_usage_percent: null,
            updated_at: "2026-07-09T09:00:00Z",
          },
        ],
      },
      {
        id: "week-claude",
        agent: "lh-build",
        session: "week-claude",
        runtime: "claude-code",
        created_at: "2026-07-08T08:00:00Z",
        updated_at: "2026-07-08T09:00:00Z",
        usage: [
          {
            session_id: "week-claude",
            model: "claude-sonnet",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.03,
            context_usage_percent: null,
            updated_at: "2026-07-08T09:00:00Z",
          },
        ],
      },
      {
        id: "legacy-claude",
        agent: "lh-build",
        session: "legacy-claude",
        created_at: "2026-07-09T06:00:00Z",
        updated_at: "2026-07-09T07:00:00Z",
        usage: [
          {
            session_id: "legacy-claude",
            model: "claude-sonnet",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.0042,
            context_usage_percent: null,
            updated_at: "2026-07-09T07:00:00Z",
          },
        ],
      },
      {
        id: "stale-session-fresh-usage",
        agent: "lh-build",
        session: "stale-session-fresh-usage",
        runtime: "codex",
        created_at: "2026-06-01T08:00:00Z",
        updated_at: "2026-06-01T09:00:00Z",
        usage: [
          {
            session_id: "stale-session-fresh-usage",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.05,
            context_usage_percent: null,
            updated_at: "2026-07-09T10:00:00Z",
          },
        ],
      },
      {
        id: "last-week-codex",
        agent: "reviewer",
        session: "last-week-codex",
        runtime: "codex",
        created_at: "2026-07-02T08:00:00Z",
        updated_at: "2026-07-02T09:00:00Z",
        usage: [
          {
            session_id: "last-week-codex",
            model: "gpt-5-mini",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.01,
            context_usage_percent: null,
            updated_at: "2026-07-02T09:00:00Z",
          },
        ],
      },
      {
        id: "last-month-claude",
        agent: "reviewer",
        session: "last-month-claude",
        runtime: "claude-code",
        created_at: "2026-06-20T08:00:00Z",
        updated_at: "2026-06-20T09:00:00Z",
        usage: [
          {
            session_id: "last-month-claude",
            model: "claude-sonnet",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.04,
            context_usage_percent: null,
            updated_at: "2026-06-20T09:00:00Z",
          },
        ],
      },
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    expect(screen.getByText("$0.15")).toBeTruthy();
    expect(screen.getByText("Top agent")).toBeTruthy();
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Codex").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("last-month-claude")).toBeTruthy();
    expect(screen.getByText("stale-session-fresh-usage")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "last 1 week" }));
    expect(screen.getByText("last 1 week cost")).toBeTruthy();
    expect(screen.queryByText("last-month-claude")).toBeNull();
    expect(screen.queryByText("last-week-codex")).toBeNull();
    expect(screen.getByText("week-claude")).toBeTruthy();
    expect(screen.getByText("stale-session-fresh-usage")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    fireEvent.click(screen.getByRole("button", { name: "By agent" }));
    expect(screen.getByLabelText("Agent cost comparison trend")).toBeTruthy();
  });

  it("shows zero-cost summaries when usage data is absent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-09T13:00:00Z").getTime(),
    );
    renderPage([
      {
        id: "no-usage",
        agent: "lh-build",
        session: "no-usage",
        runtime: "codex",
        created_at: "2026-07-09T08:00:00Z",
        updated_at: "2026-07-09T09:00:00Z",
      },
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    expect(screen.getAllByText("$0.00").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText("No sessions in the selected period."),
    ).toHaveLength(2);
  });

  it("shows n/a summaries when usage cost is unknown", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-09T13:00:00Z").getTime(),
    );
    renderPage([
      {
        id: "unknown-cost",
        agent: "reviewer",
        session: "unknown-cost",
        runtime: "claude-code",
        created_at: "2026-07-09T10:00:00Z",
        updated_at: "2026-07-09T11:00:00Z",
        usage: [
          {
            session_id: "unknown-cost",
            model: "claude-sonnet",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: null,
            context_usage_percent: null,
            updated_at: "2026-07-09T11:00:00Z",
          },
        ],
      },
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    expect(screen.getAllByText("n/a").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText(/Jul 9: n\/a/).getAttribute("style")).toBe(
      "height: 2px;",
    );
  });

  it("shows an empty state", async () => {
    renderPage([]);
    expect(await screen.findByText("No agent sessions.")).toBeTruthy();
  });
});
