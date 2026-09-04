import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "#loophub-test";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { PullRequest } from "@/api/types";
import { pullDetailRoute } from "./pulls";
import { rootRoute } from "./root";

vi.mock("@/components/app-layout", () => ({
  AppLayout: () => <Outlet />,
}));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({
    launchTerminal: vi.fn(),
    launchFailed: false,
  }),
}));
vi.mock("@/lib/use-loophub-events", () => ({
  useLoopHubEvents: () => {},
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pull: PullRequest = {
  number: 4,
  state: "open",
  title: "Browser title verification PR 1",
  body: "",
  user: { login: "me" },
  head: { ref: "feature/title", sha: "aaa" },
  base: { ref: "main", sha: "bbb" },
  base_sha: "bbb",
  merged: false,
  mergeable: true,
  mergeable_state: "unknown",
  review_state: null,
  review_gate: {
    reviewed: false,
    passed: false,
    head_sha: null,
    blocking_reason: null,
  },
  changes_addressed_at: null,
  changes_addressed_by: null,
  merge_commit_sha: null,
  additions: 0,
  deletions: 0,
  changed_files: 0,
  working: false,
  labels: [],
  comments: 0,
  created_at: "2026-09-04T00:00:00Z",
  updated_at: "2026-09-04T00:00:00Z",
  linked_issue: null,
  worktree_path: null,
  cost_stopped: false,
  merge_mode: "merge",
  github_pull: null,
  github_pr_export_started_at: null,
  commits: [],
};

function pullForNumber(number: number): PullRequest {
  return {
    ...pull,
    number,
    title: `Browser title verification PR ${number - 3}`,
    review_state: number === 4 ? null : "PASSED",
    mergeable_state: number === 4 ? "unknown" : "clean",
  };
}

function renderPullRoute() {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "pulls/get": (params: { number: number }) =>
        pullForNumber(Number(params.number)),
      "pulls/files": () => [],
      "reviews/list": () => [],
      "reviews/listComments": () => [],
      "diffFeedback/list": () => ({ threads: [], comment_counts: {} }),
      "comments/list": () => [],
      "terminal/sessions": () => ({ repos: [] }),
      "workflowRuns/stateForPull": () => null,
      "workflowRuns/totalCost": () => ({
        cost_usd: null,
        cost_status: "not_recorded",
      }),
      "pulls/githubStatus": () => ({
        state: "open",
        merged: false,
        mergeable: "unknown",
        review_decision: null,
        checks: "none",
        comments: 0,
        reviews: 0,
        unpushed_commits: 0,
        unpulled_commits: 0,
        updated_at: null,
        synced_at: "2026-09-04T00:00:00Z",
      }),
    }),
  );
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pullDetailRoute, issueRoute]),
    history: createMemoryHistory({
      initialEntries: ["/r/me/proj/pulls/4"],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("PR 詳細ルート", () => {
  it("PR 詳細ルート間の遷移で title を更新する", async () => {
    const router = renderPullRoute();

    await screen.findByRole("heading", {
      name: "Browser title verification PR 1",
      level: 1,
    });
    expect(document.title).toBe(
      "open · PR #4 · Browser title verification PR 1 · me/proj · LoopHub",
    );

    await act(async () => {
      await router.navigate({
        to: "/r/$owner/$repo/pulls/$number",
        params: { owner: "me", repo: "proj", number: "5" },
      });
    });

    await screen.findByRole("heading", {
      name: "Browser title verification PR 2",
      level: 1,
    });
    await waitFor(() => {
      expect(document.title).toBe(
        "passed · mergeable · PR #5 · Browser title verification PR 2 · me/proj · LoopHub",
      );
    });
  });
});
