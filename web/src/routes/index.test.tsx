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

  it("groups repositories, states, limits, and canonical links", async () => {
    const longTitle = "長い issue title ".repeat(12).trim();
    renderHome({
      ...emptyOverview,
      repository_count: 1,
      total_issues: 2,
      total_open_issues: 1,
      total_closed_issues: 1,
      repositories: [
        {
          repo: { full_name: "me/project", owner: "me", name: "project" },
          issues: [
            makeIssue(2, "open", longTitle),
            makeIssue(1, "closed", "Closed issue"),
          ],
          total_issues: 25,
          open_issues: 1,
          closed_issues: 1,
          issue_limit: 20,
          has_more: true,
        },
      ],
    });

    const section = (
      await screen.findByRole("heading", { name: "me/project" })
    ).closest("section")!;
    expect(within(section).getByText("open")).toBeTruthy();
    expect(within(section).getByText("closed")).toBeTruthy();
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
    expect(
      within(section)
        .getByText("Closed issue")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/r/me/project/issues/1");
    expect(
      within(section).getByLabelText(`Issue #2: ${longTitle}`),
    ).toBeTruthy();
    const issueRow = within(section).getByLabelText(`Issue #2: ${longTitle}`);
    expect(within(issueRow).queryByText("me/project")).toBeNull();
  });
});
