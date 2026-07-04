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
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type {
  IssueComment,
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
  ReviewNote,
} from "@/api/types";
import { ACTION_LOADING_MS } from "@/lib/use-fixed-loading";

// RelatedSessions and GitHub export launch through the terminal backend abstraction; stub it so the
// component tree renders without a TerminalProvider.
const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));

import { PullDetail } from "./pull-detail";
import { ToastProvider, ToastViewport } from "./toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  review_state: "PASSED",
  changes_addressed_at: null,
  changes_addressed_by: null,
  merge_commit_sha: null,
  additions: 1,
  deletions: 1,
  changed_files: 1,
  created_at: "2026-06-18T11:00:00Z",
  updated_at: "2026-06-18T12:00:00Z",
  linked_issue: {
    number: 153,
    title: "ui2: PR list + detail + merged",
    state: "open",
  },
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
    topic: "design",
    head_sha: "aaa",
    submitted_at: "2026-06-18T11:30:00Z",
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
    "reviewNotes/list": () => [],
    "comments/list": () => comments,
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

    // The PR detail shows a compact file summary instead of expanding patch lines inline.
    expect(await screen.findByText("web/src/a.ts")).toBeTruthy();
    expect(screen.queryByText("+const x = 1;")).toBeNull();
    // Review body and verdict.
    expect(screen.getByText("LGTM")).toBeTruthy();
    // Review topic tag (#209).
    expect(screen.getByText("design")).toBeTruthy();
    // Line comment — shown both inline in the diff and within its review group.
    expect(screen.getAllByText("nice constant").length).toBeGreaterThan(0);
    // Issue comment.
    expect(screen.getByText("Thanks!")).toBeTruthy();

    // Bidirectional link back to the issue this PR closes.
    const linked = screen.getByText("#153").closest("a");
    expect(linked?.getAttribute("href")).toBe("/r/me/proj/issues/153");
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

  it("integrates Markdown base/head preview into the diff dialog (#435)", async () => {
    const mdFiles: PullFile[] = [
      ...files,
      {
        filename: "README.md",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-# old\n+# new",
      },
    ];
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => mdFiles,
        "reviews/list": () => [],
        "reviews/listComments": () => [],
        "reviewNotes/list": () => [],
        "comments/list": () => [],
        "pulls/fileAtRef": (p) =>
          p.side === "base"
            ? { status: "ok", content: "# old\n" }
            : { status: "ok", content: "# new\n" },
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

    await screen.findByText("web/src/a.ts");
    expect(screen.queryByRole("button", { name: /^Preview$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /README\.md/i }));

    await screen.findByRole("dialog", { name: /Diff for README.md/i });
    expect(
      screen.queryByRole("dialog", {
        name: /Markdown preview for README.md/i,
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Diff" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Base" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Head" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Head" }));
    expect(await screen.findByRole("heading", { name: "new" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Base" }));
    expect(await screen.findByRole("heading", { name: "old" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("dialog", { name: /Diff for README.md/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /Diff for README.md/i }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("dialog", { name: /Diff for README.md/i })
        .parentElement as HTMLElement,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /README\.md/i }));
    await screen.findByRole("dialog", { name: /Diff for README.md/i });

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(await screen.findByText("+# new")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("hides the Preview button for a renamed Markdown file (mangled numstat path, #436)", async () => {
    // git numstat renders a cross-directory rename as "old => new" — this still ends in ".md" but
    // is not a resolvable git path, so `pulls.fileAtRef` would always report "missing" for it.
    const renamedFiles: PullFile[] = [
      {
        filename: "docs/old.md => top.md",
        status: "renamed",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1 @@\n-# old\n+# old\n+extra",
      },
    ];
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => renamedFiles,
        "reviews/list": () => [],
        "reviews/listComments": () => [],
        "reviewNotes/list": () => [],
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

    await screen.findByText("docs/old.md => top.md");
    fireEvent.click(
      screen.getByRole("button", { name: /docs\/old\.md => top\.md/i }),
    );
    await screen.findByRole("dialog", {
      name: /Diff for docs\/old\.md => top\.md/i,
    });
    expect(screen.queryByRole("button", { name: /^Preview$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Base" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Head" })).toBeNull();
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
        "reviewNotes/list": () => [],
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
        "reviewNotes/list": () => [],
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
        "reviewNotes/list": () => [],
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
        "reviewNotes/list": () => [],
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

  it("groups reviews by commit, collapsed by default with a verdict on each summary (#268)", async () => {
    // Two reviews against different commits: one on the PR's current head ("aaa")
    // and one on a superseded commit.
    const grouped: PullReview[] = [
      {
        id: 2,
        user: { login: "design-bot" },
        state: "REQUEST_CHANGES",
        body: "needs work",
        head_sha: "old1234deadbeef",
        submitted_at: "2026-06-18T10:00:00Z",
      },
      {
        id: 1,
        user: { login: "design-bot" },
        state: "PASS",
        body: "LGTM now",
        head_sha: "aaa",
        submitted_at: "2026-06-18T11:30:00Z",
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

    // Both commit groups render with a short-SHA heading.
    const currentSummary = await screen.findByText("aaa");
    const staleSummary = await screen.findByText("old1234");

    // Every group is collapsed by default (#268); the verdict on the summary
    // tells the state apart without expanding.
    const currentGroup = currentSummary.closest("details");
    const staleGroup = staleSummary.closest("details");
    expect(currentGroup?.open).toBe(false);
    expect(staleGroup?.open).toBe(false);

    // Existing per-commit state badges are preserved.
    expect(screen.getByText("current")).toBeTruthy();
    expect(screen.getByText("STALE")).toBeTruthy();

    // Each summary carries a collapsed verdict: PASS → "passed" on the
    // current group, REQUEST_CHANGES → "changes requested" on the stale group.
    expect(currentGroup?.querySelector("summary")?.textContent).toContain(
      "passed",
    );
    expect(staleGroup?.querySelector("summary")?.textContent).toContain(
      "changes requested",
    );
  });

  it("keeps all groups collapsed when no review targets the current head (#268)", async () => {
    // The branch advanced past every reviewed commit, so no group is current.
    // Every group stays collapsed; the verdict on each summary surfaces the state.
    const grouped: PullReview[] = [
      {
        id: 1,
        user: { login: "design-bot" },
        state: "REQUEST_CHANGES",
        body: "older feedback",
        head_sha: "older12",
        submitted_at: "2026-06-18T09:00:00Z",
      },
      {
        id: 2,
        user: { login: "design-bot" },
        state: "REQUEST_CHANGES",
        body: "newest feedback",
        head_sha: "newer34",
        submitted_at: "2026-06-18T10:00:00Z",
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

    const newest = await screen.findByText("newer34");
    const older = await screen.findByText("older12");
    expect(newest.closest("details")?.open).toBe(false);
    expect(older.closest("details")?.open).toBe(false);
    // No group targets the current head, so no "current" badge is shown.
    expect(screen.queryByText("current")).toBeNull();
    // Both groups are REQUEST_CHANGES → each summary shows "changes requested".
    expect(screen.getAllByText("changes requested").length).toBe(2);
  });

  it("resolves a group's verdict per-topic, so a later PASS clears an earlier REQUEST_CHANGES on the same topic (#533)", async () => {
    // Round 1: quality REQUEST_CHANGES against the current head. Round 2:
    // quality PASS against the same head, resolving it. A REQUEST_CHANGES on a
    // different topic (security) stays unresolved and must still dominate.
    const grouped: PullReview[] = [
      {
        id: 1,
        user: { login: "quality-bot" },
        state: "REQUEST_CHANGES",
        topic: "quality",
        body: "round 1: needs work",
        head_sha: "aaa",
        submitted_at: "2026-06-18T10:00:00Z",
      },
      {
        id: 2,
        user: { login: "security-bot" },
        state: "PASS",
        topic: "security",
        body: "security ok",
        head_sha: "aaa",
        submitted_at: "2026-06-18T10:05:00Z",
      },
      {
        id: 3,
        user: { login: "quality-bot" },
        state: "PASS",
        topic: "quality",
        body: "round 2: looks good now",
        head_sha: "aaa",
        submitted_at: "2026-06-18T11:00:00Z",
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

    const summary = (await screen.findByText("aaa")).closest("details");
    // The quality topic's REQUEST_CHANGES is superseded by its own later PASS,
    // so the group reads "passed" rather than "changes requested".
    expect(summary?.querySelector("summary")?.textContent).toContain("passed");
    expect(summary?.querySelector("summary")?.textContent).not.toContain(
      "changes requested",
    );
  });

  it("keeps a group's verdict as changes requested when an unresolved REQUEST_CHANGES sits alongside a passed topic (#533)", async () => {
    // quality is REQUEST_CHANGES with no later PASS on that topic; security
    // passed. The unresolved topic must still dominate the group verdict.
    const grouped: PullReview[] = [
      {
        id: 1,
        user: { login: "security-bot" },
        state: "PASS",
        topic: "security",
        body: "security ok",
        head_sha: "aaa",
        submitted_at: "2026-06-18T10:00:00Z",
      },
      {
        id: 2,
        user: { login: "quality-bot" },
        state: "REQUEST_CHANGES",
        topic: "quality",
        body: "still needs work",
        head_sha: "aaa",
        submitted_at: "2026-06-18T10:05:00Z",
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

    const summary = (await screen.findByText("aaa")).closest("details");
    expect(summary?.querySelector("summary")?.textContent).toContain(
      "changes requested",
    );
  });

  it("renders per-file review notes with the diff range, marking stale ones (#217)", async () => {
    // Two notes on the same file: one for the PR's current head ("aaa") and one for an
    // earlier commit, which must be flagged STALE.
    const notes: ReviewNote[] = [
      {
        id: 1,
        pull_request: { number: 30 },
        path: "web/src/a.ts",
        base_sha: "bbb0000feedface",
        commit_sha: "aaa",
        body: "Bumps the x constant to 1.",
        user: { login: "note-bot" },
        created_at: "2026-06-18T11:00:00Z",
        updated_at: "2026-06-18T11:00:00Z",
      },
      {
        id: 2,
        pull_request: { number: 30 },
        path: "web/src/a.ts",
        base_sha: "bbb0000feedface",
        commit_sha: "old9999deadbeef",
        body: "Earlier-commit note.",
        user: { login: "note-bot" },
        created_at: "2026-06-18T10:00:00Z",
        updated_at: "2026-06-18T10:00:00Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull, // head.sha === "aaa"
        "pulls/files": () => files,
        "reviews/list": () => [],
        "reviews/listComments": () => [],
        "reviewNotes/list": () => notes,
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

    await screen.findByText("web/src/a.ts");
    expect(screen.queryByText("Bumps the x constant to 1.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /web\/src\/a\.ts/i }));

    // Both note bodies render in the opened file diff.
    expect(await screen.findByText("Bumps the x constant to 1.")).toBeTruthy();
    expect(screen.getByText("Earlier-commit note.")).toBeTruthy();
    // The diff range (base→commit) is shown as short SHAs.
    expect(screen.getByText("bbb0000…aaa")).toBeTruthy();
    expect(screen.getByText("bbb0000…old9999")).toBeTruthy();
    // No reviews here, so the only badges come from the notes: one current, one STALE.
    expect(screen.getByText("current")).toBeTruthy();
    expect(screen.getByText("STALE")).toBeTruthy();
  });

  it("does not render a Resume button in the PR header (#325 — moved to the Sessions section)", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => files,
        "reviews/list": () => reviews,
        "reviews/listComments": () => lineComments,
        "reviewNotes/list": () => [],
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

  // #609: the sidebar shows an Agents section (session name + Focus) while herdr reports an
  // agent running this PR's worktree, and hides it entirely otherwise.
  it("shows the sidebar Agents section when a herdr session runs this PR", async () => {
    renderDetail({
      "terminal/sessions": () => ({
        repos: [
          {
            repo: "me/proj",
            session_name: "lh-me-proj",
            agents: [{ id: "%3", name: "dev #153", status: "working" }],
            pull_workspaces: [{ pull: 30, pane_id: "%3", status: "working" }],
          },
        ],
      }),
    });

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByText("lh-me-proj")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus" })).toBeTruthy();
  });

  it("hides the sidebar Agents section when no herdr session runs this PR", async () => {
    renderDetail({
      "terminal/sessions": () => ({ repos: [] }),
    });

    await screen.findByRole("button", { name: /^Merge$/i });
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  });
});

// #406: the PR-detail write action follows the PR's effective merge_mode. Render with an overridden
// pull so we can exercise each mode without touching the shared fixture.
function renderDetailWithPull(override: Partial<PullRequest>) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "pulls/get": () => ({ ...pull, ...override }),
      "pulls/files": () => files,
      "reviews/list": () => reviews,
      "reviews/listComments": () => lineComments,
      "reviewNotes/list": () => [],
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
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("PullDetail — GitHub export action (#406)", () => {
  it("offers Merge (not Create PR) in 'merge' mode", async () => {
    renderDetailWithPull({ merge_mode: "merge" });
    await screen.findByRole("button", { name: /^Merge$/i });
    expect(
      screen.queryByRole("button", { name: /Create PR on GitHub/i }),
    ).toBeNull();
  });

  it("offers Create PR on GitHub (not Merge) in 'github_pr' mode, dispatching the skill", async () => {
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
  });

  it("swaps to a View PR on GitHub link once exported (double-create guard)", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: {
        number: 7,
        url: "https://github.com/me/proj/pull/7",
        branch: "feature/x",
        created_by: "impl-bot",
        created_at: "2026-06-19T00:00:00Z",
      },
    });
    const link = await screen.findByRole("link", {
      name: /View PR on GitHub/i,
    });
    expect(link.getAttribute("href")).toBe("https://github.com/me/proj/pull/7");
    expect(
      screen.queryByRole("button", { name: /Create PR on GitHub/i }),
    ).toBeNull();
  });
});
