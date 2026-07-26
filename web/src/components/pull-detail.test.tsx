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
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type {
  IssueComment,
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
} from "@/api/types";
import { ACTION_LOADING_MS } from "@/lib/use-fixed-loading";

// GitHub export launches through the terminal backend abstraction; stub it so the component tree
// renders without a TerminalProvider.
const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));

import { PullDetail } from "./pull-detail";
import { ToastProvider, ToastViewport } from "./toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  launchTerminal.mockClear();
});

const pull: PullRequest = {
  number: 30,
  state: "open",
  title: "ui2: PR detail",
  body: "Render diff, reviews, comments.",
  user: { login: "impl-bot" },
  head: { ref: "issue-153", sha: "aaa" },
  base: { ref: "main", sha: "bbb" },
  base_sha: "bbb",
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
  review_state: "PASSED",
  review_gate: {
    reviewed: true,
    passed: true,
    head_sha: "aaa",
    blocking_reason: null,
  },
  changes_addressed_at: null,
  changes_addressed_by: null,
  merge_commit_sha: null,
  additions: 1,
  deletions: 1,
  changed_files: 1,
  working: false,
  labels: [],
  comments: 0,
  created_at: "2026-06-18T11:00:00Z",
  updated_at: "2026-06-18T12:00:00Z",
  linked_issue: {
    number: 153,
    title: "ui2: PR list + detail + merged",
    state: "open",
    html_url: "/issues/153",
  },
  worktree_path: null,
  cost_stopped: false,
  merge_mode: "merge",
  github_pull: null,
  commits: [
    {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      author: "Alice",
      date: "2026-06-18T12:00:00Z",
      subject: "Latest change",
    },
    {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      author: "Bob",
      date: "2026-06-17T12:00:00Z",
      subject: "Earlier change",
    },
  ],
};

const files: PullFile[] = [
  {
    filename: "web/src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-const x = 0;\n+const x = 1;",
  },
];

const reviews: PullReview[] = [
  {
    id: 1,
    user: { login: "design-bot" },
    state: "PASS",
    body: "LGTM",
    head_sha: pull.commits![0].sha,
    model: "claude-opus-4-8",
    submitted_at: "2026-06-18T11:30:00Z",
    ac_results: [],
  },
];

const lineComments: PullLineComment[] = [
  {
    id: 1,
    pull_request_review_id: 1,
    user: { login: "design-bot" },
    path: "web/src/a.ts",
    line: 1,
    side: "RIGHT",
    body: "nice constant",
    created_at: "2026-06-18T11:30:00Z",
  },
];

const comments: IssueComment[] = [
  {
    id: 9,
    user: { login: "me" },
    body: "Thanks!",
    created_at: "2026-06-18T11:45:00Z",
  },
];

function mockFetch(
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  return mockRpcFetch({
    "pulls/get": () => pull,
    "pulls/files": () => files,
    "reviews/list": () => reviews,
    "reviews/listComments": () => lineComments,
    "comments/list": () => comments,
    "terminal/sessions": () => ({ repos: [] }),
    "workflowRuns/stateForPull": () => null,
    "pulls/githubStatus": () => ({
      state: "open",
      merged: false,
      mergeable: "mergeable",
      review_decision: null,
      checks: "none",
      comments: 0,
      reviews: 0,
      updated_at: null,
      synced_at: "2026-06-18T12:00:00Z",
    }),
    "pulls/merge": () => ({ merged: true, sha: "c" }),
    "pulls/update": (p) => ({ ...pull, state: p.state }),
    ...extraHandlers,
  });
}

function renderDetail(
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  vi.stubGlobal("fetch", mockFetch(extraHandlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <PullDetail owner="me" repo="proj" number={30} />,
  });
  // The linked-issue link targets the issues route; register it for the router.
  const issuesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("PullDetail", () => {
  it("renders title, head→base, compact file summary, reviews, comments, and the linked issue", async () => {
    renderDetail();

    expect(await screen.findByText("ui2: PR detail")).toBeTruthy();
    expect(screen.getByText("issue-153")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("Render diff, reviews, comments.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Develop" })).toBeNull();
    expect(screen.queryByText("lh resume me/proj/30")).toBeNull();

    // The PR detail shows a compact file summary instead of expanding patch lines inline.
    expect(await screen.findByText("web/src/a.ts")).toBeTruthy();
    expect(screen.queryByText("+const x = 1;")).toBeNull();
    const reviewedCommit = screen
      .getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      })
      .closest("li")!;
    expect(within(reviewedCommit).getByText("Reviewed")).toBeTruthy();
    expect(within(reviewedCommit).getByText("passed")).toBeTruthy();
    expect(within(reviewedCommit).getByText("1 comment")).toBeTruthy();
    expect(within(reviewedCommit).queryByText("LGTM")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Reviews" })).toBeNull();
    fireEvent.click(
      within(reviewedCommit).getByRole("button", {
        name: "View 1 review for aaaaaaa: Latest change",
      }),
    );
    const reviewDialog = await screen.findByRole("dialog", {
      name: "Reviews for aaaaaaa: Latest change",
    });
    expect(within(reviewDialog).getByText("LGTM")).toBeTruthy();
    // Review model tag (#1107).
    expect(within(reviewDialog).getByText("claude-opus-4-8")).toBeTruthy();
    // Line comment.
    expect(within(reviewDialog).getByText("nice constant")).toBeTruthy();
    // Issue comment.
    expect(screen.getByText("Thanks!")).toBeTruthy();

    // Bidirectional link back to the issue this PR closes.
    const linked = screen.getByText("#153").closest("a");
    expect(linked?.getAttribute("href")).toBe("/r/me/proj/issues/153");
  });

  it("names the major PR regions for component debugging", async () => {
    const { container } = renderDetail();

    await screen.findByText("ui2: PR detail");
    const names = new Set(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-debug-component]"),
        (element) => element.dataset.debugComponent,
      ),
    );

    for (const name of [
      "PullDetail",
      "PullHeader",
      "PullCommitsSection",
      "PullCommitRow",
      "FilesChanged",
      "PullCommentList",
      "PullSidebar",
      "WorktreeSection",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("shows a regular PR author in the header", async () => {
    renderDetail();

    expect(await screen.findByText(/@impl-bot · opened/)).toBeTruthy();
  });

  it("hides a Workflow-generated PR author without removing other header details", async () => {
    renderDetail({
      "pulls/get": () => ({
        ...pull,
        user: { login: "Workflow #153 ui2: PR detail" },
      }),
    });

    await screen.findByText("ui2: PR detail");
    expect(screen.queryByText(/@Workflow #153/)).toBeNull();
    expect(screen.getByText(/opened .* · wants to merge/)).toBeTruthy();
    expect(screen.getByText("issue-153")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });

  // #863: a cost-stopped PR shows an "over budget" badge in the PR-detail header.
  it("shows a cost-stopped badge in the header when the PR was stopped", async () => {
    renderDetail({ "pulls/get": () => ({ ...pull, cost_stopped: true }) });
    const badge = await screen.findByTitle(
      "Stopped — agent cost limit exceeded",
    );
    expect(badge.textContent).toBe("over budget");
  });

  it("shows no cost-stopped badge in the header for a PR that was never stopped", async () => {
    renderDetail();
    await screen.findByText("ui2: PR detail");
    expect(screen.queryByText("over budget")).toBeNull();
  });

  it("copies the head branch from the PR header with visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderDetail();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Copy branch name: issue-153",
      }),
    );

    expect(writeText).toHaveBeenCalledWith("issue-153");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy(),
    );
  });

  // #1908: the base branch is copyable too, symmetrically with the head branch.
  it("copies the base branch from the PR header with visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderDetail();

    fireEvent.click(
      await screen.findByRole("button", { name: "Copy branch name: main" }),
    );

    expect(writeText).toHaveBeenCalledWith("main");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy(),
    );
  });

  it("shows the PR worktree path in the sidebar with a copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const worktreePath = "/Users/me/.loophub/worktrees/me/proj/pr-30";
    renderDetail({
      "pulls/get": () => ({ ...pull, worktree_path: worktreePath }),
    });

    const section = (
      await screen.findByRole("heading", { name: "Worktree" })
    ).closest("section")!;
    expect(within(section).getByText(worktreePath)).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        within(section).getByRole("button", { name: "Copy worktree path" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith(worktreePath);
  });

  it("shows an unavailable worktree sidebar state without an empty copy action", async () => {
    renderDetail();

    const section = (
      await screen.findByRole("heading", { name: "Worktree" })
    ).closest("section")!;
    expect(within(section).getByText("Unavailable")).toBeTruthy();
    expect(
      within(section).queryByRole("button", { name: "Copy worktree path" }),
    ).toBeNull();
  });

  it("does not render an independent Reviews section", async () => {
    renderDetail();

    await screen.findByRole("heading", {
      name: /Files changed \(1\)/,
    });
    expect(screen.queryByRole("heading", { name: "Reviews" })).toBeNull();
  });

  // The Commits section's own behaviour is covered by pull-commits-section.test.tsx; the PR detail
  // only has to place it, with this PR's commits, before Files changed.
  it("places the PR's commits before files changed in the main PR flow", async () => {
    renderDetail();

    const commitsHeading = await screen.findByRole("heading", {
      name: "Commits (2)",
    });
    const filesHeading = screen.getByRole("heading", {
      name: /Files changed \(1\)/,
    });

    expect(
      commitsHeading.compareDocumentPosition(filesHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("surfaces a commit retrieval failure through the PR error state", async () => {
    renderDetail({
      "pulls/get": () => {
        throw new RpcFault(500, "simulated git log failure");
      },
    });

    expect(await screen.findByText(/Failed to load PR #30/)).toBeTruthy();
    expect(screen.getByText(/simulated git log failure/)).toBeTruthy();
  });

  it("keeps bottom spacing after the comments section when comments are empty", async () => {
    renderDetail({ "comments/list": () => [] });

    const heading = await screen.findByRole("heading", { name: "Comments" });
    const commentsSection = heading.closest("section");

    expect(commentsSection?.className).toContain("pb-6");
    expect(commentsSection?.textContent).toContain("No comments.");
  });

  it("opens a full-size diff dialog from a file summary row and closes back to the summary", async () => {
    renderDetail();

    expect(await screen.findByText("web/src/a.ts")).toBeTruthy();
    expect(screen.queryByText("+const x = 1;")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /web\/src\/a\.ts/i }));

    expect(
      await screen.findByRole("dialog", { name: /Diff for web\/src\/a\.ts/i }),
    ).toBeTruthy();
    expect(await screen.findByText("+const x = 1;")).toBeTruthy();
    expect(screen.getAllByText("nice constant").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("dialog", { name: /Diff for web\/src\/a\.ts/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /Diff for web\/src\/a\.ts/i }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("dialog", { name: /Diff for web\/src\/a\.ts/i })
        .parentElement as HTMLElement,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /web\/src\/a\.ts/i }));
    expect(
      await screen.findByRole("dialog", { name: /Diff for web\/src\/a\.ts/i }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Close diff/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("web/src/a.ts")).toBeTruthy();
    expect(screen.queryByText("+const x = 1;")).toBeNull();
  });

  it("moves between file diffs with Prev and Next without closing the dialog", async () => {
    const multiFileDiff: PullFile[] = [
      ...files,
      {
        filename: "web/src/b.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+const y = 2;",
      },
    ];
    renderDetail({ "pulls/files": () => multiFileDiff });

    expect(await screen.findByText("web/src/a.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /web\/src\/a\.ts/i }));

    expect(
      await screen.findByRole("dialog", { name: /Diff for web\/src\/a\.ts/i }),
    ).toBeTruthy();
    expect(await screen.findByText("+const x = 1;")).toBeTruthy();
    const firstPrev = screen.getByRole("button", { name: /Prev/i });
    const firstNext = screen.getByRole("button", { name: /Next/i });
    expect((firstPrev as HTMLButtonElement).disabled).toBe(true);
    expect((firstNext as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(firstNext);

    expect(
      await screen.findByRole("dialog", { name: /Diff for web\/src\/b\.ts/i }),
    ).toBeTruthy();
    expect(await screen.findByText("+const y = 2;")).toBeTruthy();
    expect(screen.queryByText("+const x = 1;")).toBeNull();
    const secondPrev = screen.getByRole("button", { name: /Prev/i });
    const secondNext = screen.getByRole("button", { name: /Next/i });
    expect((secondPrev as HTMLButtonElement).disabled).toBe(false);
    expect((secondNext as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(secondPrev);

    expect(
      await screen.findByRole("dialog", { name: /Diff for web\/src\/a\.ts/i }),
    ).toBeTruthy();
    expect(await screen.findByText("+const x = 1;")).toBeTruthy();
  });

  it("keeps an open diff dialog in sync when the files query refetches", async () => {
    let currentFiles: PullFile[] = files;
    const { queryClient } = renderDetail({
      "pulls/files": () => currentFiles,
    });

    expect(await screen.findByText("web/src/a.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /web\/src\/a\.ts/i }));
    expect(await screen.findByText("+const x = 1;")).toBeTruthy();

    currentFiles = [
      {
        ...files[0],
        additions: 2,
        patch: "@@ -1 +1 @@\n-const x = 0;\n+const x = 2;",
      },
    ];
    await act(async () => {
      await queryClient.refetchQueries({ type: "active" });
    });

    expect(await screen.findByText("+const x = 2;")).toBeTruthy();
    expect(screen.queryByText("+const x = 1;")).toBeNull();
  });

  it("closes the PR via PATCH state=closed without merging", async () => {
    renderDetail();

    const button = await screen.findByRole("button", { name: /^Close$/i });
    fireEvent.click(button);

    await waitFor(() => {
      const call = rpcCall("pulls/update");
      expect(call).toBeTruthy();
      expect(call!.params.state).toBe("closed");
    });
  });

  it("merges the PR via the squash method when PASSED", async () => {
    renderDetail();

    const button = await screen.findByRole("button", { name: /^Merge$/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => {
      const call = rpcCall("pulls/merge");
      expect(call).toBeTruthy();
      expect(call!.params.merge_method).toBe("squash");
    });
  });

  it("shows a fixed-duration loading state on Merge and re-enables it once loading and the mutation both settle (#560)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveMerge!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveMerge = resolve;
    });
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => files,
        "reviews/list": () => reviews,
        "reviews/listComments": () => lineComments,
        "comments/list": () => comments,
        "pulls/merge": () => pending,
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PullDetail owner="me" repo="proj" number={30} />,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const button = (await screen.findByRole("button", {
      name: /^Merge$/i,
    })) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);

    // The fixed loading window elapses, but the mutation is still in flight — stay disabled so a
    // slow merge can't be double-submitted.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTION_LOADING_MS);
    });
    expect(button.disabled).toBe(true);

    // Once the mutation itself resolves, the button re-enables.
    resolveMerge({ merged: true, sha: "c" });
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });
  });

  it("surfaces a merge failure in the app toast, dismissable by its close button (#323, #574)", async () => {
    // Merge feedback no longer renders inline on the PR header; a failed mutation reports to the
    // app-shell toast (lifetime decoupled from the header / mutation observer). Mount the
    // viewport alongside the detail and assert the failure shows there and the × dismisses it.
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => files,
        "reviews/list": () => [],
        "reviews/listComments": () => [],
        "comments/list": () => [],
        "pulls/merge": () => {
          throw new RpcFault(409, "merge conflict");
        },
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
        <ToastProvider>
          <ToastViewport />
          <PullDetail owner="me" repo="proj" number={30} />
        </ToastProvider>
      ),
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // Merge PR #30 → it fails → the toast shows the failure message.
    fireEvent.click(await screen.findByRole("button", { name: /^Merge$/i }));
    expect(
      await screen.findByText("Merge failed: merge conflict"),
    ).toBeTruthy();

    // The close (×) button dismisses it immediately.
    fireEvent.click(screen.getByRole("button", { name: /Dismiss error/i }));
    await waitFor(() => {
      expect(screen.queryByText("Merge failed: merge conflict")).toBeNull();
    });
  });

  it("disables the Merge button when the PR conflicts even if PASSED (#334)", async () => {
    const conflicting: PullRequest = {
      ...pull,
      mergeable: false,
      mergeable_state: "conflict",
      review_state: "PASSED",
    };
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => conflicting,
        "pulls/files": () => files,
        "reviews/list": () => [],
        "reviews/listComments": () => [],
        "comments/list": () => [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PullDetail owner="me" repo="proj" number={30} />,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: /^Merge$/i });
    // Conflict overrides PASSED: the button is disabled and exposes the reason.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/conflict/i);

    // Clicking the disabled button must not fire a merge request.
    fireEvent.click(button);
    expect(rpcCall("pulls/merge")).toBeFalsy();
  });

  it("disables the Merge button when the PR has no commits even if PASSED (#691)", async () => {
    const noCommits: PullRequest = {
      ...pull,
      mergeable: false,
      mergeable_state: "no_commits",
      review_state: "PASSED",
    };
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => noCommits,
        "pulls/files": () => files,
        "reviews/list": () => [],
        "reviews/listComments": () => [],
        "comments/list": () => [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PullDetail owner="me" repo="proj" number={30} />,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: /^Merge$/i });
    // No commits overrides PASSED: the button is disabled and exposes the reason.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/no commits/i);

    // Clicking the disabled button must not fire a merge request.
    fireEvent.click(button);
    expect(rpcCall("pulls/merge")).toBeFalsy();
  });

  it("groups reviews under matching commits and keeps superseded commits visible", async () => {
    // One review matches a listed commit; the other targets a commit outside base..head.
    const grouped: PullReview[] = [
      {
        id: 2,
        user: { login: "design-bot" },
        state: "REQUEST_CHANGES",
        body: "needs work",
        head_sha: "old1234deadbeef",
        submitted_at: "2026-06-18T10:00:00Z",
        ac_results: [],
      },
      {
        id: 1,
        user: { login: "design-bot" },
        state: "PASS",
        body: "LGTM now",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T11:30:00Z",
        ac_results: [],
      },
    ];
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => files,
        "reviews/list": () => grouped,
        "reviews/listComments": () => [],
        "comments/list": () => [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PullDetail owner="me" repo="proj" number={30} />,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const currentGroup = (
      await screen.findByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      })
    ).closest("li")!;
    const passedBadge = within(currentGroup).getByText("passed");
    expect(passedBadge.className).toContain("text-green-600");
    expect(within(currentGroup).queryByText("LGTM now")).toBeNull();
    fireEvent.click(
      within(currentGroup).getByRole("button", {
        name: "View 1 review for aaaaaaa: Latest change",
      }),
    );
    const currentDialog = await screen.findByRole("dialog", {
      name: "Reviews for aaaaaaa: Latest change",
    });
    expect(within(currentDialog).getByText("LGTM now")).toBeTruthy();
    fireEvent.click(
      within(currentDialog).getByRole("button", { name: "Close reviews" }),
    );

    const staleReviewStatus = screen.getByRole("button", {
      name: "View 1 review for old1234",
    });
    expect(
      within(staleReviewStatus).getByText("changes requested"),
    ).toBeTruthy();
    expect(screen.queryByText("needs work")).toBeNull();
    fireEvent.click(staleReviewStatus);
    const staleDialog = await screen.findByRole("dialog", {
      name: "Reviews for old1234",
    });
    expect(within(staleDialog).getByText("needs work")).toBeTruthy();
    expect(within(staleDialog).getByText("@design-bot")).toBeTruthy();
    expect(within(staleDialog).getByText("quality")).toBeTruthy();
  });

  it("keeps every review visible when none targets a listed commit", async () => {
    const grouped: PullReview[] = [
      {
        id: 1,
        user: { login: "design-bot" },
        state: "REQUEST_CHANGES",
        body: "older feedback",
        head_sha: "older12",
        submitted_at: "2026-06-18T09:00:00Z",
        ac_results: [],
      },
      {
        id: 2,
        user: { login: "design-bot" },
        state: "REQUEST_CHANGES",
        body: "newest feedback",
        head_sha: "newer34",
        submitted_at: "2026-06-18T10:00:00Z",
        ac_results: [],
      },
    ];
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull, // head.sha === "aaa", matches no review
        "pulls/files": () => files,
        "reviews/list": () => grouped,
        "reviews/listComments": () => [],
        "comments/list": () => [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PullDetail owner="me" repo="proj" number={30} />,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("newer34")).toBeTruthy();
    expect(screen.getByText("older12")).toBeTruthy();
    expect(screen.queryByText("newest feedback")).toBeNull();
    expect(screen.queryByText("older feedback")).toBeNull();
    expect(screen.queryByText("current")).toBeNull();
    expect(screen.getAllByText("changes requested").length).toBe(2);

    fireEvent.click(
      screen.getByRole("button", { name: "View 1 review for newer34" }),
    );
    const newestDialog = await screen.findByRole("dialog", {
      name: "Reviews for newer34",
    });
    expect(within(newestDialog).getByText("newest feedback")).toBeTruthy();
    fireEvent.click(
      within(newestDialog).getByRole("button", { name: "Close reviews" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "View 1 review for older12" }),
    );
    const olderDialog = await screen.findByRole("dialog", {
      name: "Reviews for older12",
    });
    expect(within(olderDialog).getByText("older feedback")).toBeTruthy();
  });

  it("resolves a group's verdict from the latest review, so a later PASS clears an earlier REQUEST_CHANGES (#533)", async () => {
    // Round 1: REQUEST_CHANGES against the current head. Round 2: a later PASS
    // against the same head resolves it.
    const grouped: PullReview[] = [
      {
        id: 1,
        user: { login: "quality-bot" },
        state: "REQUEST_CHANGES",
        body: "round 1: needs work",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T10:00:00Z",
        ac_results: [],
      },
      {
        id: 2,
        user: { login: "security-bot" },
        state: "PASS",
        body: "security ok",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T10:05:00Z",
        ac_results: [],
      },
      {
        id: 3,
        user: { login: "quality-bot" },
        state: "PASS",
        body: "round 2: looks good now",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T11:00:00Z",
        ac_results: [],
      },
    ];
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => files,
        "reviews/list": () => grouped,
        "reviews/listComments": () => [],
        "comments/list": () => [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PullDetail owner="me" repo="proj" number={30} />,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const summary = (
      await screen.findByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      })
    ).closest("li")!;
    // The REQUEST_CHANGES is superseded by the later PASS, so the group reads
    // "passed" rather than "changes requested".
    expect(within(summary).getByText("passed")).toBeTruthy();
    expect(within(summary).queryByText("changes requested")).toBeNull();
  });

  it("keeps a group's verdict as changes requested when the latest review requests changes (#533)", async () => {
    // An earlier PASS followed by an unresolved REQUEST_CHANGES: the latest
    // review dominates the group verdict.
    const grouped: PullReview[] = [
      {
        id: 1,
        user: { login: "security-bot" },
        state: "PASS",
        body: "security ok",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T10:00:00Z",
        ac_results: [],
      },
      {
        id: 2,
        user: { login: "quality-bot" },
        state: "REQUEST_CHANGES",
        body: "still needs work",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T10:05:00Z",
        ac_results: [],
      },
    ];
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => files,
        "reviews/list": () => grouped,
        "reviews/listComments": () => [],
        "comments/list": () => [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PullDetail owner="me" repo="proj" number={30} />,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const summary = (
      await screen.findByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      })
    ).closest("li")!;
    expect(within(summary).getByText("changes requested")).toBeTruthy();
  });

  it("does not render a Resume button in the PR header (#325 — moved to the Sessions section)", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => files,
        "reviews/list": () => reviews,
        "reviews/listComments": () => lineComments,
        "comments/list": () => comments,
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PullDetail owner="me" repo="proj" number={30} />,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/issues/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // The header is mounted (Merge renders); with no related_sessions there is no Resume button anywhere.
    await screen.findByRole("button", { name: /^Merge$/i });
    expect(screen.queryByRole("button", { name: /^Resume$/ })).toBeNull();
  });

  // The sidebar Agents section lists every Herdr pane whose cwd resolves to this PR.
  it("shows the sidebar Agents section when a herdr session runs this PR", async () => {
    renderDetail({
      "terminal/sessions": () => ({
        repos: [
          {
            repo: "me/proj",
            session_name: "lh-me-proj",
            agents: [
              {
                id: "%3",
                name: "dev #30",
                status: "working",
                pull: 30,
                pull_closed: false,
              },
            ],
            pull_workspaces: [{ pull: 30, pane_id: "%3", status: "working" }],
            issue_workspaces: [],
          },
        ],
      }),
    });

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByText("dev #30")).toBeTruthy();
  });

  it("hides the sidebar Agents section when no herdr session runs this PR", async () => {
    renderDetail({
      "terminal/sessions": () => ({ repos: [] }),
    });

    await screen.findByRole("button", { name: /^Merge$/i });
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  });

  it("removes Sessions and Handoffs from the sidebar and does not fetch Handoffs", async () => {
    renderDetail({
      "pulls/get": () => ({
        ...pull,
        related_sessions: [
          {
            id: "old-session",
            agent: "lh-build",
            session: "external",
            created_at: "2026-06-18T11:00:00Z",
            updated_at: "2026-06-18T12:00:00Z",
            linked_at: "2026-06-18T11:00:00Z",
            resume: { resumable: false },
          },
        ],
      }),
    });

    await screen.findByText("ui2: PR detail");
    expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Handoffs" })).toBeNull();
    expect(rpcCall("handoffs/list")).toBeUndefined();
  });

  it("shows Workflow run state once in the sidebar with history access", async () => {
    renderDetail({
      "workflowRuns/stateForPull": () => ({
        id: 12,
        workflow_id: 3,
        workflow_name: "Implementation loop",
        status: "running",
        current_step: "verify",
        rework_count: 2,
        needs_human_reason: "Review the unexpected API change",
        issue_number: 153,
        pr_number: 30,
        created_at: "2026-06-18T11:00:00Z",
        updated_at: "2026-06-18T12:00:00Z",
        latest_review: null,
      }),
    });

    await screen.findByText("Implementation loop");
    const headings = screen.getAllByText("Workflow run");
    expect(headings).toHaveLength(1);
    expect(headings[0].closest("aside")).toBeTruthy();
    expect(screen.getByText("Implementation loop")).toBeTruthy();
    expect(screen.getByText("run #12")).toBeTruthy();
    expect(screen.getByText("Verify")).toBeTruthy();
    expect(screen.getByText("· rework ×2")).toBeTruthy();
    expect(screen.getByText("Needs human")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View history" })).toBeTruthy();
  });

  it.each([
    { currentStep: "execute", label: "Execute" },
    { currentStep: "verify", label: "Verify" },
  ])("animates the $label step while its PR agent is working", async ({
    currentStep,
    label,
  }) => {
    renderDetail({
      "terminal/sessions": () => ({
        repos: [
          {
            repo: "me/proj",
            session_name: "lh-me-proj",
            agents: [
              {
                id: "%3",
                name: "workflow step #12",
                status: "working",
                pull: 30,
                pull_closed: false,
              },
            ],
            pull_workspaces: [{ pull: 30, pane_id: "%3", status: "working" }],
            issue_workspaces: [],
          },
        ],
      }),
      "workflowRuns/stateForPull": () => ({
        id: 12,
        workflow_id: 3,
        workflow_name: "Implementation loop",
        status: "running",
        current_step: currentStep,
        rework_count: 0,
        needs_human_reason: null,
        issue_number: 153,
        pr_number: 30,
        created_at: "2026-06-18T11:00:00Z",
        updated_at: "2026-06-18T12:00:00Z",
        latest_review: null,
        verification_status: "unverified",
      }),
    });

    await screen.findByText("Implementation loop");
    await waitFor(() =>
      expect(screen.getByText(label).className).toContain(
        "animate-[workflow-stage-glow",
      ),
    );
  });

  it("does not show continuing for a verified running Workflow run", async () => {
    renderDetail({
      "workflowRuns/stateForPull": () => ({
        id: 12,
        workflow_id: 3,
        workflow_name: "Implementation loop",
        status: "running",
        current_step: "verify",
        rework_count: 0,
        needs_human_reason: null,
        issue_number: 153,
        pr_number: 30,
        created_at: "2026-06-18T11:00:00Z",
        updated_at: "2026-06-18T12:00:00Z",
        latest_review: null,
        verification_status: "verified",
      }),
    });

    await screen.findByText("Implementation loop");
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(
      screen.getByText("Verify passed for the current HEAD."),
    ).toBeTruthy();
    expect(screen.getByText("Verify")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View history" })).toBeTruthy();
    expect(screen.queryByText(/continuing/i)).toBeNull();
  });

  it("hides Workflow run when none is linked", async () => {
    renderDetail({ "workflowRuns/stateForPull": () => null });
    await screen.findByText("ui2: PR detail");
    await waitFor(() => expect(screen.queryByText("Workflow run")).toBeNull());
  });

  it("keeps PR detail visible and reports a Workflow run fetch failure", async () => {
    renderDetail({
      "workflowRuns/stateForPull": () => {
        throw new RpcFault(500, "workflow state unavailable");
      },
    });

    expect(await screen.findByText("ui2: PR detail")).toBeTruthy();
    expect(
      await screen.findByText("Failed to load Workflow run."),
    ).toBeTruthy();
  });
});

// #406: the PR-detail write action follows the PR's effective merge_mode. Render with an overridden
// pull so we can exercise each mode without touching the shared fixture.
function renderDetailWithPull(
  override: Partial<PullRequest>,
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "pulls/get": () => ({ ...pull, ...override }),
      "pulls/files": () => files,
      "reviews/list": () => reviews,
      "reviews/listComments": () => lineComments,
      "comments/list": () => comments,
      "pulls/githubStatus": () => ({
        state: "open",
        merged: false,
        mergeable: "mergeable",
        review_decision: null,
        checks: "none",
        comments: 0,
        reviews: 0,
        updated_at: null,
        synced_at: "2026-06-18T12:00:00Z",
      }),
      ...extraHandlers,
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <PullDetail owner="me" repo="proj" number={30} />,
  });
  const issuesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function linkedGithubPull(pushedSha: string | null) {
  return {
    number: 7,
    url: "https://github.com/me/proj/pull/7",
    branch: "feature/x",
    created_by: "impl-bot",
    created_at: "2026-06-19T00:00:00Z",
    github_merged: false,
    github_merged_at: null,
    pushed_sha: pushedSha,
  } satisfies NonNullable<PullRequest["github_pull"]>;
}

describe("PullDetail — Review with Crit action (#1578 / #1594)", () => {
  it("offers Review with Crit on the Files changed header and launches pr-crit in Herdr", async () => {
    renderDetailWithPull({ merge_mode: "merge" });
    const filesHeading = await screen.findByRole("heading", {
      name: /Files changed/,
    });
    const headerRow = filesHeading.parentElement!;
    const button = within(headerRow).getByRole("button", {
      name: /Review with Crit/i,
    });
    expect(screen.queryByRole("button", { name: /^Crit review$/i })).toBeNull();
    fireEvent.click(button);
    expect(launchTerminal).toHaveBeenCalledTimes(1);
    const opts = launchTerminal.mock.calls[0][0];
    expect(opts.repo).toBe("me/proj");
    expect(opts.workflow).toBe("pr-crit");
    expect(opts.prNumber).toBe(30);
    expect(opts.label).toBe("crit PR #30");
  });
});

describe("PullDetail — GitHub export action (#406)", () => {
  it("offers Merge (not Create PR) in 'merge' mode", async () => {
    renderDetailWithPull({ merge_mode: "merge" });
    await screen.findByRole("button", { name: /^Merge$/i });
    expect(
      screen.queryByRole("button", { name: /Create PR on GitHub/i }),
    ).toBeNull();
  });

  it("offers Create PR on GitHub (not Merge) in 'github_pr' mode, injecting the export prompt", async () => {
    renderDetailWithPull({ merge_mode: "github_pr", github_pull: null });
    const button = await screen.findByRole("button", {
      name: /Create PR on GitHub/i,
    });
    expect(screen.queryByRole("button", { name: /^Merge$/i })).toBeNull();

    fireEvent.click(button);
    expect(launchTerminal).toHaveBeenCalledTimes(1);
    const opts = launchTerminal.mock.calls[0][0];
    expect(opts.repo).toBe("me/proj");
    expect(opts.workflow).toBe("github-pr-export");
    expect(opts.prNumber).toBe(30);
    // #1892: no slash-command skill — the full export instructions are injected as the prompt,
    // interpolated with this PR's repo/number.
    expect(opts.prompt).toContain("lh pr create-github-pr 30 --repo me/proj");
    expect(opts.prompt).not.toContain("/lh-create-github-pr");
  });

  it("swaps to a View PR on GitHub link once exported (double-create guard)", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: linkedGithubPull(null),
    });
    const link = await screen.findByRole("link", {
      name: /View PR on GitHub/i,
    });
    expect(link.getAttribute("href")).toBe("https://github.com/me/proj/pull/7");
    expect(
      screen.queryByRole("button", { name: /Create PR on GitHub/i }),
    ).toBeNull();
  });

  it("keeps Close and omits Mark as merged after GitHub merge detection", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: {
        ...linkedGithubPull(null),
        github_merged: true,
        github_merged_at: "2026-07-15T00:00:00Z",
      },
    });

    expect(
      await screen.findByRole("button", { name: /^Close$/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Mark as merged/i }),
    ).toBeNull();
  });

  it("disables Push to GitHub when the current head is already pushed", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: linkedGithubPull(pull.head.sha),
    });

    const button = await screen.findByRole("button", {
      name: /Push to GitHub/i,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(rpcCall("pulls/pushGithubPull")).toBeUndefined();
  });

  it("pushes an unpushed head and disables the action after the refreshed state arrives", async () => {
    let pushedSha = "previous-head";
    let resolveRefresh: (() => void) | undefined;
    const githubPull = () => linkedGithubPull(pushedSha);
    renderDetailWithPull(
      {},
      {
        "pulls/get": () => {
          const refreshedPull = {
            ...pull,
            merge_mode: "github_pr" as const,
            github_pull: githubPull(),
          };
          if (pushedSha !== pull.head.sha) return refreshedPull;
          return new Promise((resolve) => {
            resolveRefresh = () => resolve(refreshedPull);
          });
        },
        "pulls/pushGithubPull": () => {
          pushedSha = pull.head.sha!;
          return githubPull();
        },
      },
    );

    const button = (await screen.findByRole("button", {
      name: /Push to GitHub/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => {
      expect(rpcCall("pulls/pushGithubPull")?.params).toMatchObject({
        repo: "me/proj",
        number: 30,
        force: false,
      });
      expect(resolveRefresh).toBeTypeOf("function");
    });
    expect(button.disabled).toBe(true);

    resolveRefresh?.();
    await waitFor(() => expect(button.disabled).toBe(true));
  });

  it("force-pushes when Force push is chosen from the push dropdown (#1861)", async () => {
    renderDetailWithPull(
      {
        merge_mode: "github_pr",
        github_pull: linkedGithubPull("previous-head"),
      },
      {
        "pulls/pushGithubPull": () => linkedGithubPull(pull.head.sha),
      },
    );

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: /Push options/i }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Force push to GitHub/i }),
    );

    await waitFor(() => {
      expect(rpcCall("pulls/pushGithubPull")?.params).toMatchObject({
        repo: "me/proj",
        number: 30,
        force: true,
      });
    });
  });
});
