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
} from "@testing-library/react";
import { useState } from "react";
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

// The Resume button (#276) opens a terminal via useTerminal(); capture the call.
const { openTerminal } = vi.hoisted(() => ({ openTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminal: () => ({ openTerminal }),
}));

import { PullDetail } from "./pull-detail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  openTerminal.mockClear();
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
  mergeable: true,
  mergeable_state: "clean",
  review_state: "APPROVED",
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
    state: "APPROVE",
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

function mockFetch() {
  return mockRpcFetch({
    "pulls/get": () => pull,
    "pulls/files": () => files,
    "reviews/list": () => reviews,
    "reviews/listComments": () => lineComments,
    "reviewNotes/list": () => [],
    "comments/list": () => comments,
    "pulls/merge": () => ({ merged: true, sha: "c" }),
    "pulls/update": (p) => ({ ...pull, state: p.state }),
  });
}

function renderDetail() {
  vi.stubGlobal("fetch", mockFetch());
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
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("PullDetail", () => {
  it("renders title, head→base, diff, reviews, line comments, comments, and the linked issue", async () => {
    renderDetail();

    expect(await screen.findByText("ui2: PR detail")).toBeTruthy();
    expect(screen.getByText("issue-153")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();

    // Diff line from the patch (added line).
    expect(await screen.findByText("+const x = 1;")).toBeTruthy();
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

  it("renders the cross-PR conflict section with conflicting files and a PR link", async () => {
    const withConflicts: PullRequest = {
      ...pull,
      conflicts_with: [
        { number: 41, title: "another change", files: ["core/shared.ts"] },
      ],
    };
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => withConflicts,
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
    const pullsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/r/$owner/$repo/pulls/$number",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, issuesRoute, pullsRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/May conflict with 1 open PR/)).toBeTruthy();
    expect(screen.getByText("another change")).toBeTruthy();
    // Conflicting file is listed.
    expect(screen.getByText("core/shared.ts")).toBeTruthy();
    // Link points at the conflicting PR's detail page.
    const link = screen.getByText("#41").closest("a");
    expect(link?.getAttribute("href")).toBe("/r/me/proj/pulls/41");
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

  it("merges the PR via the squash method when APPROVED", async () => {
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

  it("does not carry a merge-failed error onto a different PR on the same route (#321)", async () => {
    // The PR-detail route only changes its `number` param between PRs, so React reuses the same
    // PullHeader instance — and with it the useMergePull observer's error state — unless the header
    // is keyed by PR number. Reproduce the no-loading-gap path (a loading gap would unmount the
    // header and mask the leak) by pre-seeding PR #31's detail, so switching to it renders
    // synchronously. The merge fails on #30; that error must not appear on #31.
    const pull30 = pull; // number 30, APPROVED + open → Merge enabled
    const pull31: PullRequest = { ...pull, number: 31, title: "second pr" };
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": (p) => (p.number === 31 ? pull31 : pull30),
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
    // Seed PR #31 so navigating to it has no loading gap (the bug's reproduction condition).
    queryClient.setQueryData(["pull", "me/proj", 31], pull31);

    function Switcher() {
      const [n, setN] = useState(30);
      return (
        <>
          <button type="button" onClick={() => setN(31)}>
            go-31
          </button>
          <PullDetail owner="me" repo="proj" number={n} />
        </>
      );
    }
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: Switcher,
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

    // Merge PR #30 → it fails → the error surfaces.
    fireEvent.click(await screen.findByRole("button", { name: /^Merge$/i }));
    expect(await screen.findByText(/Merge failed:/)).toBeTruthy();

    // Navigate to PR #31 on the same route (no loading gap thanks to the seed).
    fireEvent.click(screen.getByRole("button", { name: "go-31" }));

    // The new PR's header renders; the stale merge error from #30 is gone.
    expect(await screen.findByText("second pr")).toBeTruthy();
    expect(screen.queryByText(/Merge failed:/)).toBeNull();
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
        state: "APPROVE",
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

    // Each summary carries a collapsed verdict: APPROVE → "approved" on the
    // current group, REQUEST_CHANGES → "changes requested" on the stale group.
    expect(currentGroup?.querySelector("summary")?.textContent).toContain(
      "approved",
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

    // Both note bodies render in the file diff.
    expect(await screen.findByText("Bumps the x constant to 1.")).toBeTruthy();
    expect(screen.getByText("Earlier-commit note.")).toBeTruthy();
    // The diff range (base→commit) is shown as short SHAs.
    expect(screen.getByText("bbb0000…aaa")).toBeTruthy();
    expect(screen.getByText("bbb0000…old9999")).toBeTruthy();
    // No reviews here, so the only badges come from the notes: one current, one STALE.
    expect(screen.getByText("current")).toBeTruthy();
    expect(screen.getByText("STALE")).toBeTruthy();
  });

  // Render the detail with a specific `pulls/resumable` result (the rest of the methods reuse the
  // shared fixtures). Returns nothing; assertions read the rendered output / the openTerminal spy.
  function renderWithResumable(resumable: boolean) {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": () => pull,
        "pulls/files": () => files,
        "reviews/list": () => reviews,
        "reviews/listComments": () => lineComments,
        "reviewNotes/list": () => [],
        "comments/list": () => comments,
        "pulls/resumable": () => ({ resumable }),
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
  }

  it("shows the Resume button and launches `lh resume <id>` in a terminal when resumable (#276)", async () => {
    renderWithResumable(true);

    const button = await screen.findByRole("button", { name: /^Resume$/ });
    fireEvent.click(button);

    // Same openTerminal route as the issue Build button: fully-qualified id, repo cwd, and the
    // linked issue as the terminal's PR top-region ref.
    expect(openTerminal).toHaveBeenCalledWith({
      command: "lh resume me/proj/30",
      repo: "me/proj",
      label: "resume #30",
      issueRef: { owner: "me", repo: "proj", number: 153 },
    });
  });

  it("hides the Resume button when the PR cannot be resumed (#276)", async () => {
    renderWithResumable(false);

    // The header is mounted (Merge renders), so an absent Resume button means it is gated, not unrendered.
    await screen.findByRole("button", { name: /^Merge$/i });
    expect(screen.queryByRole("button", { name: /^Resume$/ })).toBeNull();
  });
});
