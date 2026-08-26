import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "#loophub-test";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { DashboardOverview } from "@/api/types";
import { HomePage } from "./index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const emptyOverview: DashboardOverview = {
  repositories: [],
  repository_count: 0,
  total_issues: 0,
  total_open_issues: 0,
  total_closed_issues: 0,
  repository_issue_limit: 20,
  issues: [],
  recent_issues_limit: 100,
  recentIssuesLimit: 100,
};

function makeIssue(number: number, state: "open" | "closed", title: string) {
  return {
    number,
    state,
    title,
    body: "",
    target_branch: null,
    user: { login: "me" },
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    has_open_pull_request: true,
  };
}

function renderHome(data: DashboardOverview = emptyOverview) {
  vi.stubGlobal("fetch", mockRpcFetch({ "dashboard/overview": () => data }));
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: HomePage,
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, repoRoute, issueRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("HomePage", () => {
  it("shows the empty active-repository state", async () => {
    renderHome();

    expect(
      await screen.findByRole("heading", { name: "Repository issues" }),
    ).toBeTruthy();
    expect(screen.getByText("No active repositories.")).toBeTruthy();
  });

  it("open issue、状態件数、上限、canonical link を表示する", async () => {
    const longTitle = "長い issue title ".repeat(12).trim();
    renderHome({
      ...emptyOverview,
      repository_count: 1,
      total_issues: 25,
      total_open_issues: 21,
      total_closed_issues: 4,
      repositories: [
        {
          repo: { full_name: "me/project", owner: "me", name: "project" },
          issues: Array.from({ length: 20 }, (_, index) =>
            makeIssue(
              index + 2,
              "open",
              index === 0 ? longTitle : `Open issue ${index + 2}`,
            ),
          ),
          total_issues: 25,
          open_issues: 21,
          closed_issues: 4,
          issue_limit: 20,
          has_more: true,
        },
      ],
    });

    const section = (
      await screen.findByRole("heading", { name: "me/project" })
    ).closest("section")!;
    expect(within(section).getAllByText("open")).toHaveLength(20);
    expect(within(section).getByText(/closed/)).toBeTruthy();
    expect(
      within(section).getByText(
        /Showing the latest 20 issues\. View all 25 issues/,
      ),
    ).toBeTruthy();
    expect(
      within(section)
        .getByText("me/project")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/r/me/project");
    expect(
      within(section).getByText("View issue list").getAttribute("href"),
    ).toBe("/r/me/project?state=all");
    expect(within(section).queryByText("Closed issue")).toBeNull();
    expect(
      within(section).getByLabelText(`Issue #2: ${longTitle}`),
    ).toBeTruthy();
    const issueRow = within(section).getByLabelText(`Issue #2: ${longTitle}`);
    expect(within(issueRow).queryByText("me/project")).toBeNull();
  });

  it("open issue がない repository では既存の空状態を表示する", async () => {
    renderHome({
      ...emptyOverview,
      repository_count: 1,
      total_issues: 1,
      total_closed_issues: 1,
      repositories: [
        {
          repo: { full_name: "me/project", owner: "me", name: "project" },
          issues: [],
          total_issues: 1,
          open_issues: 0,
          closed_issues: 1,
          issue_limit: 20,
          has_more: false,
        },
      ],
    });

    const section = (
      await screen.findByRole("heading", { name: "me/project" })
    ).closest("section")!;
    expect(within(section).getByText("No issues.")).toBeTruthy();
    expect(within(section).queryByText("Closed issue")).toBeNull();
  });

  it("dashboard が返した repository の順序をそのまま表示する", async () => {
    renderHome({
      ...emptyOverview,
      repository_count: 4,
      repositories: [
        {
          repo: { full_name: "acme/Alpha", owner: "acme", name: "Alpha" },
          issues: [],
          total_issues: 0,
          open_issues: 0,
          closed_issues: 0,
          issue_limit: 20,
          has_more: false,
        },
        {
          repo: { full_name: "Acme/widget", owner: "Acme", name: "widget" },
          issues: [],
          total_issues: 0,
          open_issues: 0,
          closed_issues: 0,
          issue_limit: 20,
          has_more: false,
        },
        {
          repo: { full_name: "me/beta", owner: "me", name: "beta" },
          issues: [],
          total_issues: 0,
          open_issues: 0,
          closed_issues: 0,
          issue_limit: 20,
          has_more: false,
        },
        {
          repo: { full_name: "me/zulu", owner: "me", name: "zulu" },
          issues: [],
          total_issues: 0,
          open_issues: 0,
          closed_issues: 0,
          issue_limit: 20,
          has_more: false,
        },
      ],
    });

    await screen.findByRole("heading", { name: "me/zulu" });
    const sections = screen
      .getAllByRole("heading")
      .filter((heading) => heading.closest("section"))
      .map((heading) => heading.textContent?.trim());
    expect(sections).toEqual([
      "acme/Alpha",
      "Acme/widget",
      "me/beta",
      "me/zulu",
    ]);
  });
});
