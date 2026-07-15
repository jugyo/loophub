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
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  review_state: "PASSED",
  review_gate: {
    reviewed: true,
    all_topics_passed: true,
    topics: [
      {
        topic: "quality",
        head_sha: "aaa",
        state: "passed",
        blocking_reason: null,
      },
    ],
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
    topic: "design",
    head_sha: "aaa",
    model: "claude-opus-4-8",
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
    "comments/list": () => comments,
    "terminal/sessions": () => ({ repos: [] }),
    "workflowRuns/stateForPull": () => null,
    "pulls/githubStatus": () => ({
      state: "open",
      is_draft: false,
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
    // Review body and verdict.
    expect(screen.getByText("LGTM")).toBeTruthy();
    // Review topic tag (#209).
    expect(screen.getByText("design")).toBeTruthy();
    // Review model tag (#1107).
    expect(screen.getByText("claude-opus-4-8")).toBeTruthy();
    // Line comment — shown both inline in the diff and within its review group.
    expect(screen.getAllByText("nice constant").length).toBeGreaterThan(0);
    // Issue comment.
    expect(screen.getByText("Thanks!")).toBeTruthy();

    // Bidirectional link back to the issue this PR closes.
    const linked = screen.getByText("#153").closest("a");
    expect(linked?.getAttribute("href")).toBe("/r/me/proj/issues/153");
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

  it("renders files changed before reviews in the main PR flow", async () => {
    renderDetail();

    const filesHeading = await screen.findByRole("heading", {
      name: /Files changed \(1\)/,
    });
    const reviewsHeading = screen.getByRole("heading", { name: "Reviews" });

    expect(
      filesHeading.compareDocumentPosition(reviewsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders commit metadata newest first in the main PR flow", async () => {
    renderDetail();

    const heading = await screen.findByRole("heading", {
      name: "Commits (2)",
    });
    const section = heading.closest("section")!;
    const rows = within(section).getAllByRole("listitem");

    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("aaaaaaa");
    expect(rows[0].textContent).toContain("Latest change");
    expect(rows[0].textContent).toContain("Alice");
    expect(rows[1].textContent).toContain("bbbbbbb");
    expect(rows[1].textContent).toContain("Earlier change");
    expect(rows[1].textContent).toContain("Bob");
    expect(
      within(rows[0])
        .getByText(/ago|just now/)
        .closest("time")?.dateTime,
    ).toBe("2026-06-18T12:00:00Z");
  });

  it("marks only confirmed pushed commits for a linked GitHub PR", async () => {
    renderDetail({
      "pulls/get": () => ({
        ...pull,
        github_pull: {
          number: 30,
          url: "https://github.com/me/proj/pull/30",
          branch: "feature/push-state",
          created_by: "impl-bot",
          created_at: "2026-06-18T12:00:00Z",
          github_merged: false,
          github_merged_at: null,
          pushed_sha: pull.commits?.[1]?.sha ?? null,
        },
        commits: [
          { ...pull.commits![0], pushed_to_github: false },
          { ...pull.commits![1], pushed_to_github: true },
        ],
      }),
    });

    const section = (
      await screen.findByRole("heading", { name: "Commits (2)" })
    ).closest("section")!;
    const rows = within(section).getAllByRole("listitem");
    expect(within(rows[0]).queryByText("Pushed")).toBeNull();
    expect(within(rows[1]).getByText("Pushed")).toBeTruthy();
  });

  it("does not show GitHub push state for an unlinked PR", async () => {
    renderDetail({
      "pulls/get": () => ({
        ...pull,
        commits: pull.commits?.map((commit) => ({
          ...commit,
          pushed_to_github: true,
        })),
      }),
    });

    await screen.findByRole("heading", { name: "Commits (2)" });
    expect(screen.queryByText("Pushed")).toBeNull();
  });

  it("opens a commit diff, closes it, and switches to another commit", async () => {
    const earlierFiles: PullFile[] = [
      {
        filename: "web/src/earlier.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+export const earlier = true;",
      },
    ];
    renderDetail({
      "pulls/commitFiles": (params) =>
        params.sha === pull.commits?.[0]?.sha ? files : earlierFiles,
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      }),
    );

    const latestDialog = await screen.findByRole("dialog", {
      name: "Changes in aaaaaaa: Latest change",
    });
    expect(within(latestDialog).getByText("aaaaaaa")).toBeTruthy();
    expect(within(latestDialog).getByText("Latest change")).toBeTruthy();
    expect(await within(latestDialog).findByText("+const x = 1;")).toBeTruthy();
    expect(rpcCall("pulls/commitFiles")?.params).toEqual({
      repo: "me/proj",
      number: 30,
      sha: pull.commits?.[0]?.sha,
    });

    fireEvent.click(
      within(latestDialog).getByRole("button", { name: "Close commit diff" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(
      screen.getByRole("button", {
        name: "View changes in bbbbbbb: Earlier change",
      }),
    );
    const earlierDialog = await screen.findByRole("dialog", {
      name: "Changes in bbbbbbb: Earlier change",
    });
    expect(
      await within(earlierDialog).findByText("+export const earlier = true;"),
    ).toBeTruthy();
    expect(within(earlierDialog).queryByText("+const x = 1;")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("distinguishes loading and empty commit diffs", async () => {
    let resolveFiles: (files: PullFile[]) => void = () => {};
    const pending = new Promise<PullFile[]>((resolve) => {
      resolveFiles = resolve;
    });
    renderDetail({ "pulls/commitFiles": () => pending });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Changes in aaaaaaa: Latest change",
    });
    expect(within(dialog).getByText("Loading commit diff…")).toBeTruthy();

    resolveFiles([]);
    expect(
      await within(dialog).findByText("No changes in this commit."),
    ).toBeTruthy();
    expect(within(dialog).queryByText("Loading commit diff…")).toBeNull();
  });

  it("shows commit diff retrieval failures in the dialog", async () => {
    renderDetail({
      "pulls/commitFiles": () => {
        throw new RpcFault(500, "simulated commit diff failure");
      },
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Changes in aaaaaaa: Latest change",
    });
    expect(
      await within(dialog).findByText(/Failed to load commit diff/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/simulated commit diff failure/),
    ).toBeTruthy();
  });

  it("renders an empty state when the PR has no commits", async () => {
    renderDetail({ "pulls/get": () => ({ ...pull, commits: [] }) });

    const heading = await screen.findByRole("heading", {
      name: "Commits (0)",
    });
    const section = heading.closest("section")!;

    expect(within(section).getByText("No commits.")).toBeTruthy();
    expect(within(section).queryAllByRole("listitem")).toHaveLength(0);
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

  it("copies the displayed file path from the diff dialog with visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
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

    const dialog = await screen.findByRole("dialog", {
      name: /Diff for web\/src\/a\.ts/i,
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Copy file path: web/src/a.ts",
      }),
    );

    expect(writeText).toHaveBeenCalledWith("web/src/a.ts");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Copied" }),
      ).toBeTruthy(),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: /Next/i }));
    const nextDialog = await screen.findByRole("dialog", {
      name: /Diff for web\/src\/b\.ts/i,
    });
    expect(
      within(nextDialog).getByRole("button", {
        name: "Copy file path: web/src/b.ts",
      }),
    ).toBeTruthy();
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
    expect(
      within(screen.getByRole("dialog", { name: /Diff for README.md/i }))
        .getAllByRole("button")
        .map(
          (button) =>
            button.getAttribute("aria-label") ?? button.textContent?.trim(),
        ),
    ).toEqual([
      "Copy file path: README.md",
      "Diff",
      "Base",
      "Head",
      "Prev",
      "Next",
      "Close diff",
    ]);

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

  it("hides Preview but copies the target path for a renamed Markdown file (mangled numstat path, #436)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
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
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy file path: top.md" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith("top.md");
    expect(screen.queryByRole("button", { name: /^Preview$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Base" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Head" })).toBeNull();
  });

  it("copies the target path for a braced renamed file path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const renamedFiles: PullFile[] = [
      {
        filename: "sub/{old/name.md => new/name2.md}",
        status: "renamed",
        additions: 1,
        deletions: 0,
        patch: "",
      },
    ];
    renderDetail({ "pulls/files": () => renamedFiles });

    await screen.findByText("sub/{old/name.md => new/name2.md}");
    fireEvent.click(
      screen.getByRole("button", {
        name: /sub\/\{old\/name\.md => new\/name2\.md\}/i,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Diff for sub\/\{old\/name\.md => new\/name2\.md\}/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: sub/new/name2.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("sub/new/name2.md");
  });

  it("copies structured head filenames for renamed targets containing the rename marker text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const renamedFiles: PullFile[] = [
      {
        filename: "old.txt => new => target.txt",
        previousFilename: "old.txt",
        headFilename: "new => target.txt",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: "",
      },
    ];
    renderDetail({ "pulls/files": () => renamedFiles });

    await screen.findByText("old.txt => new => target.txt");
    fireEvent.click(
      screen.getByRole("button", { name: /old\.txt => new => target\.txt/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Diff for old\.txt => new => target\.txt/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: new => target.txt",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("new => target.txt");
  });

  it("keeps the diff dialog copy button for a non-renamed file path containing the rename marker text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const literalMarkerFiles: PullFile[] = [
      {
        filename: "docs/a => b.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    renderDetail({ "pulls/files": () => literalMarkerFiles });

    await screen.findByText("docs/a => b.ts");
    fireEvent.click(screen.getByRole("button", { name: /docs\/a => b\.ts/i }));
    const dialog = await screen.findByRole("dialog", {
      name: /Diff for docs\/a => b\.ts/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/a => b.ts",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/a => b.ts");
  });

  it("copies a visible escaped path for filenames with hidden control characters", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const controlCharFiles: PullFile[] = [
      {
        filename: "docs/readme\n\tinstall.md",
        headFilename: "docs/readme\n\tinstall.md",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    renderDetail({ "pulls/files": () => controlCharFiles });

    await screen.findByText("docs/readme install.md");
    fireEvent.click(
      screen.getByRole("button", { name: /docs\/readme\s+install\.md/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Diff for docs\/readme\s+install\.md/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/readme\\n\\tinstall.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/readme\\n\\tinstall.md");
  });

  it("copies a visible escaped path for filenames with zero-width characters", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const zeroWidthFiles: PullFile[] = [
      {
        filename: "docs/readme\u200binstall.md",
        headFilename: "docs/readme\u200binstall.md",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    renderDetail({ "pulls/files": () => zeroWidthFiles });

    await screen.findByText("docs/readme\u200binstall.md");
    fireEvent.click(
      screen.getByRole("button", { name: /docs\/readme.*install\.md/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Diff for docs\/readme.*install\.md/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/readme\\u200binstall.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/readme\\u200binstall.md");
  });

  it("copies a visible escaped path for filenames with default-ignorable characters", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const defaultIgnorableFiles: PullFile[] = [
      {
        filename: "docs/readme\ufe0finstall.md",
        headFilename: "docs/readme\ufe0finstall.md",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    renderDetail({ "pulls/files": () => defaultIgnorableFiles });

    await screen.findByText("docs/readme\uFE0Finstall.md");
    fireEvent.click(
      screen.getByRole("button", { name: /docs\/readme.*install\.md/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Diff for docs\/readme.*install\.md/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/readme\\ufe0finstall.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/readme\\ufe0finstall.md");
  });

  it("copies a braced escape for supplementary default-ignorable characters", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const supplementaryFiles: PullFile[] = [
      {
        filename: "docs/readme\u{e0100}install.md",
        headFilename: "docs/readme\u{e0100}install.md",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    renderDetail({ "pulls/files": () => supplementaryFiles });

    await screen.findByText("docs/readme\u{e0100}install.md");
    fireEvent.click(
      screen.getByRole("button", { name: /docs\/readme.*install\.md/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Diff for docs\/readme.*install\.md/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/readme\\u{e0100}install.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/readme\\u{e0100}install.md");
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
        topic: "quality",
        submitted_at: "2026-06-18T10:00:00Z",
      },
      {
        id: 1,
        user: { login: "design-bot" },
        state: "PASS",
        body: "LGTM now",
        head_sha: "aaa",
        topic: null,
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

    // The current marker stays neutral while the review verdict keeps its
    // state-specific color.
    const currentBadge = screen.getByText("current");
    expect(currentBadge.className).toContain("text-foreground");
    expect(currentBadge.className).not.toContain("text-link");
    const passedBadge = within(currentGroup as HTMLElement).getByText("passed");
    expect(passedBadge.className).toContain("text-green-600");
    expect(screen.queryByText("STALE")).toBeNull();

    // Each summary carries a collapsed verdict: PASS → "passed" on the
    // current group, REQUEST_CHANGES → "changes requested" on the old group.
    expect(currentGroup?.querySelector("summary")?.textContent).toContain(
      "passed",
    );
    expect(staleGroup?.querySelector("summary")?.textContent).toContain(
      "changes requested",
    );
    expect(staleGroup?.querySelector("summary")?.textContent).not.toContain(
      "STALE",
    );
    expect(staleGroup).toBeTruthy();
    const staleGroupContent = within(staleGroup as HTMLElement);
    expect(staleGroupContent.getByText("needs work")).toBeTruthy();
    expect(staleGroupContent.getByText("@design-bot")).toBeTruthy();
    expect(staleGroupContent.getByText("quality")).toBeTruthy();
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
        topic: null,
        submitted_at: "2026-06-18T09:00:00Z",
      },
      {
        id: 2,
        user: { login: "design-bot" },
        state: "REQUEST_CHANGES",
        body: "newest feedback",
        head_sha: "newer34",
        topic: null,
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
        latest_verdict: null,
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
        is_draft: false,
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
      });
      expect(resolveRefresh).toBeTypeOf("function");
    });
    expect(button.disabled).toBe(true);

    resolveRefresh?.();
    await waitFor(() => expect(button.disabled).toBe(true));
  });
});
