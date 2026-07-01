import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { Issue, PullRequest } from "@/api/types";
import { TerminalPrHeader } from "./terminal-pr-header";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const issueWithPr: Issue = {
  number: 12,
  state: "open",
  title: "issue twelve",
  body: "",
  user: { login: "me" },
  labels: [],
  comments: 0,
  created_at: "2026-06-17T11:00:00Z",
  updated_at: "2026-06-17T12:00:00Z",
  linked_pull_request: {
    number: 30,
    title: "the pull request",
    state: "open",
    merged: false,
  },
};

const pull: PullRequest = {
  number: 30,
  state: "open",
  title: "the pull request",
  body: "",
  user: { login: "me" },
  head: { ref: "loophub/issue-12", sha: "abc" },
  base: { ref: "main", sha: "def" },
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
  review_state: "PASSED",
  changes_addressed_at: null,
  changes_addressed_by: null,
  merge_commit_sha: null,
  additions: 1,
  deletions: 0,
  changed_files: 1,
  working: false,
  created_at: "2026-06-17T11:00:00Z",
  updated_at: "2026-06-17T12:00:00Z",
  linked_issue: { number: 12, title: "issue twelve", state: "open" },
  worktree_path: "/home/me/.loophub/worktrees/me/proj/issue-12",
};

function renderHeader(getIssue: () => Issue, getPull?: () => PullRequest) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "issues/get": getIssue,
      "pulls/get": getPull ?? (() => pull),
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <TerminalPrHeader issueRef={{ owner: "me", repo: "proj", number: 12 }} />
    ),
  });
  // Both link targets must be registered for the router to resolve hrefs.
  const pullsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const issuesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, pullsRoute, issuesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("TerminalPrHeader", () => {
  it("renders the linked PR as the star: title link, state, issue link, worktree path + copy", async () => {
    renderHeader(() => issueWithPr);

    // PR title is a link to the PR detail (the star).
    const title = await screen.findByText("the pull request");
    const titleLink = title.closest("a");
    expect(titleLink?.getAttribute("href")).toBe("/r/me/proj/pulls/30");

    // PR state: a passed review collapses to a visible "passed" badge.
    expect(screen.getByText("passed")).toBeTruthy();

    // Issue link as supporting info.
    const issueLink = screen.getByText("issue #12").closest("a");
    expect(issueLink?.getAttribute("href")).toBe("/r/me/proj/issues/12");

    // Repo + head branch shown quietly.
    expect(screen.getByText(/me\/proj · loophub\/issue-12/)).toBeTruthy();

    // Worktree path is shown and copyable.
    expect(
      screen.getByText("/home/me/.loophub/worktrees/me/proj/issue-12"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /copy worktree path/i }),
    ).toBeTruthy();
  });

  it("falls back gracefully while the PR does not exist yet", async () => {
    const noPr: Issue = { ...issueWithPr, linked_pull_request: null };
    renderHeader(() => noPr);

    // Minimal region: the issue it is building, plus a waiting hint — never broken.
    const issueLink = (await screen.findByText("issue #12")).closest("a");
    expect(issueLink?.getAttribute("href")).toBe("/r/me/proj/issues/12");
    expect(screen.getByText(/waiting for PR/i)).toBeTruthy();
  });
});
