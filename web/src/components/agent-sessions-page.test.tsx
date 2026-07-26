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
  waitFor,
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

const ORIGINAL_TIME_ZONE = process.env.TZ;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (ORIGINAL_TIME_ZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TIME_ZONE;
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
    path: "/stats",
    component: AgentSessionsPage,
  });
  const dbRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/stats/db",
    component: () => <div data-testid="db-stats-page" />,
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
    routeTree: rootRoute.addChildren([
      sessionsRoute,
      dbRoute,
      issueRoute,
      pullRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/stats"] }),
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

function costedSession(
  id: string,
  createdAt: string,
  costUsd: number,
): AgentSession {
  return {
    id,
    agent: "lh-build",
    session: id,
    runtime: "codex",
    created_at: createdAt,
    updated_at: createdAt,
    usage: [
      {
        session_id: id,
        model: "gpt-5.5",
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 10,
        cost_usd: costUsd,
        context_usage_percent: null,
        updated_at: createdAt,
      },
    ],
  };
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
      await screen.findByRole("heading", { name: "Stats" })
    ).closest("[class*='w-full']");
    expect(root?.className).toContain("w-full");
    expect(root?.className).not.toContain("max-w-content");
    expect(root?.className).not.toContain("mx-auto");
  });

  it("shows Agent cost and DB Stats tabs with Agent cost selected", async () => {
    renderPage();

    const tablist = await screen.findByRole("tablist", {
      name: "Stats categories",
    });
    const costTab = within(tablist).getByRole("tab", { name: "Agent cost" });
    const dbTab = within(tablist).getByRole("tab", { name: "DB Stats" });

    expect(costTab.getAttribute("aria-selected")).toBe("true");
    expect(dbTab.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tabpanel", { name: "Agent cost" })).toBeTruthy();
    // Each tab navigates to its own route, so both stay Tab-reachable instead of
    // relying on a roving tabindex the navigation would unmount.
    expect(costTab.getAttribute("tabindex")).toBeNull();
    expect(dbTab.getAttribute("tabindex")).toBeNull();
  });

  it("opens the DB Stats tab at /stats/db", async () => {
    const { router } = renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "DB Stats" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/stats/db"),
    );
    expect(await screen.findByTestId("db-stats-page")).toBeTruthy();
  });

  it("shows sessions in the selected period by cost with usage totals and linked work", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-04T13:00:00Z").getTime(),
    );
    renderPage();

    expect(await screen.findByRole("heading", { name: "Stats" })).toBeTruthy();
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
    expect(within(rows[1]).getByTitle("2026-07-04T12:00:00Z").textContent).toBe(
      "1h ago",
    );

    const issue = within(rows[1]).getByRole("link", { name: "Issue #725" });
    expect(issue.getAttribute("href")).toBe("/r/jugyo/loophub/issues/725");
    const pull = within(rows[1]).getByRole("link", { name: "PR #735" });
    expect(pull.getAttribute("href")).toBe("/r/ju%20gyo/loop%23hub/pulls/735");

    expect(screen.queryByText("s-old")).toBeNull();
  });

  it("groups runtime-less legacy lh-dev sessions as Claude Code", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-09T13:00:00Z").getTime(),
    );
    renderPage([
      {
        id: "legacy-lh-dev",
        agent: "lh-dev",
        session: "legacy-lh-dev",
        created_at: "2026-07-09T08:00:00Z",
        updated_at: "2026-07-09T09:00:00Z",
        usage: [
          {
            session_id: "legacy-lh-dev",
            model: "claude-sonnet",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.01,
            context_usage_percent: null,
            updated_at: "2026-07-09T09:00:00Z",
          },
        ],
      },
    ]);

    expect(await screen.findByText("legacy-lh-dev")).toBeTruthy();
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: "By agent" }));
    expect(screen.getByLabelText("Jul 9 Claude Code: $0.01")).toBeTruthy();
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
            updated_at: "2026-07-06T09:00:00Z",
          },
        ],
      },
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    expect(screen.getByText("$0.10")).toBeTruthy();
    expect(screen.getByLabelText("Jun 20: $0.04")).toBeTruthy();
    expect(screen.getByText("Top agent")).toBeTruthy();
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Codex").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("last-month-claude")).toBeTruthy();
    expect(screen.queryByText("stale-session-fresh-usage")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "last 1 week" }));
    expect(screen.getByText("last 1 week cost")).toBeTruthy();
    expect(screen.queryByText("last-month-claude")).toBeNull();
    expect(screen.queryByText("last-week-codex")).toBeNull();
    expect(screen.getByText("week-claude")).toBeTruthy();
    expect(screen.queryByText("stale-session-fresh-usage")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    fireEvent.click(screen.getByRole("button", { name: "By agent" }));
    expect(screen.getByLabelText("Agent cost comparison trend")).toBeTruthy();
  });

  it("uses local calendar boundaries across the daylight-saving start", async () => {
    process.env.TZ = "America/Los_Angeles";
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2025-03-10T12:00:00-07:00").getTime(),
    );
    renderPage([
      costedSession("late-local-february", "2025-03-01T07:30:00Z", 0.08),
      costedSession("before-local-range", "2025-03-04T07:30:00Z", 0.01),
      costedSession("late-dst-start-day", "2025-03-10T06:30:00Z", 0.02),
      costedSession("late-local-end-day", "2025-03-11T06:30:00Z", 0.04),
      costedSession("after-local-range", "2025-03-11T07:00:00Z", 0.08),
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "last 1 week" }));

    const overview = screen.getByText("last 1 week cost").parentElement;
    expect(overview && within(overview).getByText("$0.06")).toBeTruthy();
    expect(screen.getByLabelText("Mar 9: $0.02")).toBeTruthy();
    expect(screen.getByLabelText("Mar 10: $0.04")).toBeTruthy();
    expect(screen.getByText("late-dst-start-day")).toBeTruthy();
    expect(screen.getByText("late-local-end-day")).toBeTruthy();
    expect(screen.queryByText("before-local-range")).toBeNull();
    expect(screen.queryByText("after-local-range")).toBeNull();

    const comparison = screen.getByRole("heading", {
      name: "Agent comparison",
    }).parentElement;
    expect(comparison && within(comparison).getByText("$0.06")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "By agent" }));
    expect(screen.getByLabelText("Mar 9 Codex: $0.02")).toBeTruthy();
    expect(screen.getByLabelText("Mar 10 Codex: $0.04")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "last 1 month" }));
    expect(screen.getByText("late-local-february")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    expect(screen.getByLabelText("Feb 24 Codex: $0.08")).toBeTruthy();
    expect(screen.getByLabelText("Mar 3 Codex: $0.03")).toBeTruthy();
    expect(screen.getByLabelText("Mar 10 Codex: $0.04")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    expect(screen.getByLabelText("Feb 2025 Codex: $0.08")).toBeTruthy();
    expect(screen.getByLabelText("Mar 2025 Codex: $0.07")).toBeTruthy();
  });

  it("groups UTC boundary sessions by Tokyo calendar days and Monday weeks", async () => {
    process.env.TZ = "Asia/Tokyo";
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-09T12:00:00+09:00").getTime(),
    );
    renderPage([
      costedSession("before-local-range", "2026-07-02T14:59:00Z", 0.16),
      costedSession("local-friday", "2026-07-02T15:30:00Z", 0.01),
      costedSession("local-sunday", "2026-07-05T14:30:00Z", 0.02),
      costedSession("local-monday", "2026-07-05T15:30:00Z", 0.04),
      costedSession("local-thursday", "2026-07-09T14:30:00Z", 0.08),
      costedSession("after-local-range", "2026-07-09T15:00:00Z", 0.16),
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "last 1 week" }));

    const overview = screen.getByText("last 1 week cost").parentElement;
    expect(overview && within(overview).getByText("$0.15")).toBeTruthy();
    expect(screen.getByLabelText("Jul 3: $0.01")).toBeTruthy();
    expect(screen.getByLabelText("Jul 5: $0.02")).toBeTruthy();
    expect(screen.getByLabelText("Jul 6: $0.04")).toBeTruthy();
    expect(screen.getByLabelText("Jul 9: $0.08")).toBeTruthy();
    expect(screen.queryByText("before-local-range")).toBeNull();
    expect(screen.queryByText("after-local-range")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    expect(screen.getByLabelText("Jun 29: $0.03")).toBeTruthy();
    expect(screen.getByLabelText("Jul 6: $0.12")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    expect(screen.getByLabelText("Jul 2026: $0.15")).toBeTruthy();
  });

  it("keeps one bucket per local calendar day across the daylight-saving end", async () => {
    process.env.TZ = "America/Los_Angeles";
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2025-11-03T12:00:00-08:00").getTime(),
    );
    renderPage([
      costedSession("first-0130", "2025-11-02T08:30:00Z", 0.01),
      costedSession("second-0130", "2025-11-02T09:30:00Z", 0.02),
      costedSession("late-25-hour-day", "2025-11-03T07:30:00Z", 0.04),
      costedSession("after-local-range", "2025-11-04T08:00:00Z", 0.08),
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "last 1 week" }));

    const chart = screen.getByLabelText("Total cost trend");
    const bucketLabels = [...chart.querySelectorAll('g[role="img"]')].map(
      (bucket) => bucket.getAttribute("aria-label"),
    );
    expect(bucketLabels).toEqual([
      "Oct 28: $0.00",
      "Oct 29: $0.00",
      "Oct 30: $0.00",
      "Oct 31: $0.00",
      "Nov 1: $0.00",
      "Nov 2: $0.07",
      "Nov 3: $0.00",
    ]);
    expect(screen.getByText("first-0130")).toBeTruthy();
    expect(screen.getByText("second-0130")).toBeTruthy();
    expect(screen.getByText("late-25-hour-day")).toBeTruthy();
    expect(screen.queryByText("after-local-range")).toBeNull();
  });

  it("keeps long daily charts inside the chart frame with value guides", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-09T13:00:00Z").getTime(),
    );
    const { container } = renderPage(
      Array.from({ length: 90 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 3, 11 + index, 8));
        const updated = new Date(Date.UTC(2026, 3, 11 + index, 9));
        const createdAt = date.toISOString();
        const updatedAt = updated.toISOString();
        return {
          id: `quarter-${index}`,
          agent: "lh-build",
          session: `quarter-${index}`,
          runtime: "codex",
          created_at: createdAt,
          updated_at: updatedAt,
          usage: [
            {
              session_id: `quarter-${index}`,
              model: "gpt-5.5",
              input_tokens: 100,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 10,
              cost_usd: 0.01,
              context_usage_percent: null,
              updated_at: updatedAt,
            },
          ],
        };
      }),
    );

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "last 3 months" }));

    const chart = screen.getByLabelText("Total cost trend");
    expect(chart.className).not.toContain("overflow-x-auto");
    expect(chart.querySelector("svg")).toBeTruthy();
    // Y-axis value guides are rendered by the chart library.
    expect(chart.textContent).toContain("$0.01");
    expect(screen.getByLabelText("Apr 11: $0.01")).toBeTruthy();
    expect(container.querySelector('[title="Apr 11"]')?.className).toContain(
      "text-left",
    );
    expect(container.querySelector('[title="Jul 9"]')?.className).toContain(
      "text-right",
    );
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
      {
        id: "zero-reviewer",
        agent: "reviewer",
        session: "zero-reviewer",
        runtime: "reviewer",
        created_at: "2026-07-09T10:00:00Z",
        updated_at: "2026-07-09T11:00:00Z",
        usage: [
          {
            session_id: "zero-reviewer",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0,
            context_usage_percent: null,
            updated_at: "2026-07-09T11:00:00Z",
          },
        ],
      },
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    expect(screen.getAllByText("$0.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("no-usage")).toBeTruthy();
    expect(screen.getByText("zero-reviewer")).toBeTruthy();
    expect(
      screen.queryByText("No sessions in the selected period."),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "By agent" }));
    const zeroAgent = screen.getByLabelText("Jul 9 Codex: $0.00");
    expect(zeroAgent.tagName.toLowerCase()).toBe("rect");
    // Zero-cost agents render an accessible baseline marker with a finite y.
    expect(zeroAgent.getAttribute("y")).not.toContain("NaN");
    expect(Number(zeroAgent.getAttribute("y"))).toBeGreaterThan(0);
    expect(screen.getByLabelText("Jul 9 reviewer: $0.00")).toBeTruthy();
  });

  it("shows known cost with an unknown marker when usage cost is partially unknown", async () => {
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
          {
            session_id: "unknown-cost",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.02,
            context_usage_percent: null,
            updated_at: "2026-07-09T11:00:00Z",
          },
        ],
      },
      {
        id: "zero-known",
        agent: "reviewer",
        session: "zero-known",
        runtime: "codex",
        created_at: "2026-07-09T09:00:00Z",
        updated_at: "2026-07-09T09:30:00Z",
        usage: [
          {
            session_id: "zero-known",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0,
            context_usage_percent: null,
            updated_at: "2026-07-09T09:30:00Z",
          },
        ],
      },
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    expect(screen.getAllByText("$0.02+").length).toBeGreaterThanOrEqual(2);
    // The bucket carries the "+" total via its aria-label and the unknown-cost
    // note via its tooltip <title>.
    const unknownBucket = screen.getByLabelText("Jul 9: $0.02+");
    expect(unknownBucket.querySelector("title")?.textContent).toContain(
      "includes additional usage with unknown cost",
    );
    // Sorted by cost desc: the $0.02+ session outranks the $0.00 one.
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("unknown-cost")).toBeTruthy();
    expect(within(rows[2]).getByText("zero-known")).toBeTruthy();
  });

  it("keeps known agent costs visible when another agent has unknown cost", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-09T13:00:00Z").getTime(),
    );
    renderPage([
      {
        id: "known-codex",
        agent: "lh-build",
        session: "known-codex",
        runtime: "codex",
        created_at: "2026-07-09T08:00:00Z",
        updated_at: "2026-07-09T09:00:00Z",
        usage: [
          {
            session_id: "known-codex",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.05,
            context_usage_percent: null,
            updated_at: "2026-07-09T09:00:00Z",
          },
        ],
      },
      {
        id: "unknown-claude",
        agent: "lh-build",
        session: "unknown-claude",
        runtime: "claude-code",
        created_at: "2026-07-09T10:00:00Z",
        updated_at: "2026-07-09T11:00:00Z",
        usage: [
          {
            session_id: "unknown-claude",
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
      {
        id: "mixed-codex",
        agent: "lh-build",
        session: "mixed-codex",
        runtime: "codex",
        created_at: "2026-07-09T12:00:00Z",
        updated_at: "2026-07-09T12:30:00Z",
        usage: [
          {
            session_id: "mixed-codex",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: null,
            context_usage_percent: null,
            updated_at: "2026-07-09T12:30:00Z",
          },
        ],
      },
      {
        id: "zero-reviewer",
        agent: "reviewer",
        session: "zero-reviewer",
        runtime: "reviewer",
        created_at: "2026-07-09T13:00:00Z",
        updated_at: "2026-07-09T13:30:00Z",
        usage: [
          {
            session_id: "zero-reviewer",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0,
            context_usage_percent: null,
            updated_at: "2026-07-09T13:30:00Z",
          },
        ],
      },
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "By agent" }));

    const bucket = screen.getByLabelText("Jul 9: $0.05+");
    expect(bucket.querySelector("title")?.textContent).toContain(
      "includes additional usage with unknown cost",
    );
    // The known Codex cost stays drawn as a stacked segment even though the
    // same agent also has unknown-cost usage.
    const knownCodex = screen.getByLabelText("Jul 9 Codex: $0.05");
    expect(knownCodex.tagName.toLowerCase()).toBe("rect");
    expect(Number(knownCodex.getAttribute("height"))).toBeGreaterThan(0);
    // Unknown- and zero-cost agents still render accessible markers with finite
    // positions (no NaN).
    const unknownCodex = screen.getByLabelText(/Jul 9 Codex: \$0\.05\+/);
    expect(unknownCodex.getAttribute("y")).not.toContain("NaN");
    expect(Number(unknownCodex.getAttribute("y"))).toBeGreaterThanOrEqual(0);
    expect(screen.getByLabelText(/Jul 9 Claude Code: n\/a/)).toBeTruthy();
    const zeroReviewer = screen.getByLabelText("Jul 9 reviewer: $0.00");
    expect(Number(zeroReviewer.getAttribute("y"))).toBeGreaterThan(0);
    // Empty buckets still render without producing NaN geometry.
    expect(screen.getByLabelText("Jun 10: $0.00")).toBeTruthy();
  });

  it("stacks agents in a consistent order across buckets in By agent mode", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-07-09T13:00:00Z").getTime(),
    );
    // Cost dominance flips per day: Codex leads on Jul 8, Claude Code leads on
    // Jul 9. Globally Codex is the top agent (0.07 vs 0.06), so it must sit at
    // the bottom of the stack in both buckets.
    renderPage([
      {
        id: "jul8-codex",
        agent: "lh-build",
        session: "jul8-codex",
        runtime: "codex",
        created_at: "2026-07-08T08:00:00Z",
        updated_at: "2026-07-08T09:00:00Z",
        usage: [
          {
            session_id: "jul8-codex",
            model: "gpt-5.5",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.05,
            context_usage_percent: null,
            updated_at: "2026-07-08T09:00:00Z",
          },
        ],
      },
      {
        id: "jul8-claude",
        agent: "lh-build",
        session: "jul8-claude",
        runtime: "claude-code",
        created_at: "2026-07-08T08:00:00Z",
        updated_at: "2026-07-08T09:00:00Z",
        usage: [
          {
            session_id: "jul8-claude",
            model: "claude-sonnet",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.01,
            context_usage_percent: null,
            updated_at: "2026-07-08T09:00:00Z",
          },
        ],
      },
      {
        id: "jul9-codex",
        agent: "lh-build",
        session: "jul9-codex",
        runtime: "codex",
        created_at: "2026-07-09T08:00:00Z",
        updated_at: "2026-07-09T09:00:00Z",
        usage: [
          {
            session_id: "jul9-codex",
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
        id: "jul9-claude",
        agent: "lh-build",
        session: "jul9-claude",
        runtime: "claude-code",
        created_at: "2026-07-09T08:00:00Z",
        updated_at: "2026-07-09T09:00:00Z",
        usage: [
          {
            session_id: "jul9-claude",
            model: "claude-sonnet",
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
            cost_usd: 0.05,
            context_usage_percent: null,
            updated_at: "2026-07-09T09:00:00Z",
          },
        ],
      },
    ]);

    expect(await screen.findByText("last 1 month cost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "By agent" }));

    // A larger y is closer to the baseline (bottom of the stack). Codex is the
    // global top agent, so it stacks at the bottom (largest y) in every bucket,
    // even on Jul 9 where Claude Code has the higher per-bucket cost.
    const yOf = (label: string) =>
      Number(screen.getByLabelText(label).getAttribute("y"));

    expect(yOf("Jul 8 Codex: $0.05")).toBeGreaterThan(
      yOf("Jul 8 Claude Code: $0.01"),
    );
    expect(yOf("Jul 9 Codex: $0.02")).toBeGreaterThan(
      yOf("Jul 9 Claude Code: $0.05"),
    );
  });

  it("shows an empty state", async () => {
    renderPage([]);
    expect(await screen.findByText("No agent sessions.")).toBeTruthy();
  });
});
