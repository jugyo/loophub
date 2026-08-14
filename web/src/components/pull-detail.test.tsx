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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type {
  DiffFeedbackThread,
  IssueComment,
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
} from "@/api/types";
import { ACTION_LOADING_MS } from "@/lib/use-fixed-loading";
import { GITHUB_PR_EXPORT_PENDING_TTL_MS } from "../../../core/github-pr-export-pending.ts";

// GitHub export launches through the terminal backend abstraction; stub it so the component tree
// renders without a TerminalProvider.
// `launchState.failed` stands in for the launch mutation's isError: the real hook flips it when the
// RPC rejects, and a test flips it from inside launchTerminal to play out a rejected launch (#2383).
const { launchTerminal, launchState } = vi.hoisted(() => ({
  launchTerminal: vi.fn(),
  launchState: { failed: false },
}));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({
    launchTerminal,
    launchFailed: launchState.failed,
  }),
}));

import { PullDetail } from "./pull-detail";
import { ToastProvider, ToastViewport } from "./toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  launchTerminal.mockReset();
  launchState.failed = false;
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
  github_pr_export_started_at: null,
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
    author_type: "agent",
    state: "PASS",
    body: "LGTM",
    head_sha: pull.commits![0].sha,
    model: "claude-opus-4-8",
    submitted_at: "2026-06-18T11:30:00Z",
    duration_seconds: null,
    ac_results: [],
  },
];

const lineComments: PullLineComment[] = [
  {
    id: 1,
    pull_request_review_id: 1,
    user: { login: "design-bot" },
    author_type: "agent",
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
    author_type: "human",
    body: "Thanks!",
    created_at: "2026-06-18T11:45:00Z",
    reactions: [],
    archived_at: null,
  },
  {
    id: 11,
    user: { login: "impl-bot" },
    author_type: "agent",
    body: "Rebased on main.",
    created_at: "2026-06-18T11:50:00Z",
    reactions: [],
    archived_at: null,
  },
];

const diffFeedback: DiffFeedbackThread[] = [
  {
    id: 1,
    pr_number: 30,
    anchor: {
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      path: "web/src/a.ts",
      original_path: null,
      side: "RIGHT",
      start_line: 1,
      end_line: 1,
    },
    freshness: "current",
    created_by: "reviewer",
    created_by_type: "agent",
    created_at: "2026-07-29T00:00:00Z",
    messages: [
      {
        id: 1,
        thread_id: 1,
        author: "reviewer",
        author_type: "agent",
        body: "First comment",
        created_at: "2026-07-29T00:00:00Z",
        reactions: [],
      },
      {
        id: 2,
        thread_id: 1,
        author: "author",
        author_type: "agent",
        body: "Reply",
        created_at: "2026-07-29T00:01:00Z",
        reactions: [],
      },
    ],
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
    "diffFeedback/list": () => ({ threads: [], comment_counts: {} }),
    "comments/list": () => comments,
    "terminal/sessions": () => ({ repos: [] }),
    "workflowRuns/stateForPull": () => null,
    "workflowRuns/totalCost": () => ({
      cost_usd: null,
      cost_status: "not_recorded",
    }),
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
  initialEntries: string[] = ["/"],
) {
  vi.stubGlobal("fetch", mockFetch(extraHandlers));
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
  // The linked-issue link targets the issues route; register it for the router.
  const issuesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
    history: createMemoryHistory({ initialEntries }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("PullDetail", () => {
  it("shows diff comment counts in the file list and diff sidebar", async () => {
    renderDetail({
      "diffFeedback/list": () => ({
        threads: diffFeedback,
        comment_counts: { "web/src/a.ts": 2 },
      }),
    });

    const filesChanged = await screen.findByRole("heading", {
      name: /Files changed \(1\)/,
    });
    const section = filesChanged.closest("section");
    if (!section) throw new Error("Files changed section not found");
    expect(
      await within(section).findByLabelText("2 diff comments"),
    ).toBeTruthy();

    fireEvent.click(
      within(section).getByRole("button", { name: /web\/src\/a\.ts/ }),
    );
    const sidebar = await screen.findByRole("complementary", {
      name: "Changed files",
    });
    expect(within(sidebar).getByLabelText("2 diff comments")).toBeTruthy();
    expect(
      Array.from(
        within(sidebar).getByRole("button", { name: "web/src/a.ts" }).children,
      ).map((child) => child.textContent),
    ).toEqual(["M", "web/src/a.ts", "+1−1", "", "2"]);
  });

  // The badge counts and the previous-threads list are the screen's own diff feedback, so they
  // ride along on the page fetch; only opening a file in the diff dialog asks for threads by
  // path (#123).
  it("renders diff feedback from the page fetch, without a diffFeedback/list call", async () => {
    renderDetail({
      "diffFeedback/list": () => ({
        threads: diffFeedback,
        comment_counts: { "web/src/a.ts": 2 },
      }),
    });

    const filesChanged = await screen.findByRole("heading", {
      name: /Files changed \(1\)/,
    });
    const section = filesChanged.closest("section");
    if (!section) throw new Error("Files changed section not found");
    expect(
      await within(section).findByLabelText("2 diff comments"),
    ).toBeTruthy();
    fireEvent.click(
      within(section).getByRole("button", { name: "Previous diff threads" }),
    );
    expect(await within(section).findByText("First comment")).toBeTruthy();
    expect(rpcCall("diffFeedback/list")).toBeFalsy();
  });

  // Archiving has no optimistic update and emits no event, so the page query is what has to
  // refetch — the previous-threads list it seeds would otherwise sit on the pre-archive value
  // and the action would look like it did nothing (#123).
  it("shows a previous thread as archived after archiving it", async () => {
    let archivedAt: string | null = null;
    renderDetail({
      "diffFeedback/list": () => ({
        threads: diffFeedback.map((thread) => ({
          ...thread,
          archived_at: archivedAt,
        })),
        comment_counts: { "web/src/a.ts": 2 },
      }),
      "diffFeedback/archive": () => {
        archivedAt = "2026-07-30T00:00:00Z";
        return {};
      },
    });

    const filesChanged = await screen.findByRole("heading", {
      name: /Files changed \(1\)/,
    });
    const section = filesChanged.closest("section");
    if (!section) throw new Error("Files changed section not found");
    fireEvent.click(
      within(section).getByRole("button", { name: "Previous diff threads" }),
    );
    const card = await within(section).findByLabelText("Diff thread 1");
    fireEvent.pointerDown(
      within(card).getByRole("button", { name: "Actions for diff thread 1" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    expect(
      await within(section).findByLabelText("Archived diff thread 1"),
    ).toBeTruthy();
  });

  it("does not offer a ready action after changes are requested", async () => {
    renderDetailWithPull({
      review_state: "CHANGES_REQUESTED",
      review_gate: {
        reviewed: true,
        passed: false,
        head_sha: "aaa",
        blocking_reason: "request_changes",
      },
    });

    expect(await screen.findByText("changes")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Mark ready for re-review" }),
    ).toBeNull();
  });

  it("renders title, head→base, file summary, reviews, comments, and the linked issue", async () => {
    const { container } = renderDetail();

    expect(await screen.findByText("ui2: PR detail")).toBeTruthy();
    // Branch names are scoped to the sidebar's PR details section, the one place they appear (#59).
    const details = container.querySelector<HTMLElement>(
      '[data-debug-component="PullInfoSection"]',
    )!;
    expect(within(details).getByText("issue-153")).toBeTruthy();
    expect(within(details).getByText("main")).toBeTruthy();
    expect(screen.getByText("Render diff, reviews, comments.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Develop" })).toBeNull();

    // The existing file summary opens its diff in a dialog instead of expanding inline.
    const filesSection = (
      await screen.findByRole("heading", {
        name: /Files changed \(1\)/,
      })
    ).closest("section")!;
    expect(await within(filesSection).findByText("web/src/a.ts")).toBeTruthy();
    expect(screen.queryByText("const x = 1;")).toBeNull();
    fireEvent.click(
      within(filesSection).getByRole("button", {
        name: /web\/src\/a\.ts/i,
      }),
    );
    const fileDialog = await screen.findByRole("dialog", {
      name: /Diff for web\/src\/a\.ts/i,
    });
    expect(within(fileDialog).getByText("const x = 1;")).toBeTruthy();
    expect(within(fileDialog).getByLabelText("New line 1")).toBeTruthy();
    expect(
      within(fileDialog).getByRole("button", { name: "Split" }),
    ).toBeTruthy();
    // #2451: review line comments have no place in the diff view — the dialog shows diff feedback
    // threads alone.
    expect(within(fileDialog).queryByText("nice constant")).toBeNull();
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
    const linked = within(details).getByText("#153").closest("a");
    expect(linked?.getAttribute("href")).toBe("/r/me/proj/issues/153");
  });

  // #59: the header's own "Comments (n)" link is gone — the Comments tab is the same in-page
  // anchor, and the section heading below it still carries the count.
  it("links to the comments section from the tabs instead of the header", async () => {
    const { container } = renderDetail({
      "pulls/get": () => ({ ...pull, comments: 3 }),
    });

    await screen.findByText("ui2: PR detail");
    expect(screen.queryByRole("link", { name: "Comments (3)" })).toBeNull();
    const commentsTab = screen.getByRole("link", { name: "Comments" });
    expect(commentsTab.getAttribute("href")).toBe("#comments");
    act(() => commentsTab.focus());
    expect(document.activeElement).toBe(commentsTab);
    expect(
      container.querySelector('[data-debug-component="PullCommentList"]')?.id,
    ).toBe("comments");
  });

  it("counts the comments in the Comments heading", async () => {
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "Comments (2)" }),
    ).toBeTruthy();
  });

  // #145/#215: the comment list is the backend-assembled timeline — commits, reviews and
  // conversation comments appear in chronological order (oldest first), while line comments stay
  // available to the Diff view only.
  it("renders commits, reviews and comments in timeline order without diff comments", async () => {
    renderDetail();

    const section = (
      await screen.findByRole("heading", {
        name: "Comments (2)",
      })
    ).closest("section")!;
    // The fixture's timestamps order them: commit bbbb (oldest), review, comment 9, comment 11,
    // commit aaaa (newest). The review entry is its minimal one-liner verdict (#313).
    const order = [
      "Earlier change",
      "passed",
      "Thanks!",
      "Rebased on main.",
      "Latest change",
    ];
    const nodes = order.map((text) => within(section).getByText(text));
    for (let index = 0; index < nodes.length - 1; index += 1) {
      expect(
        nodes[index].compareDocumentPosition(nodes[index + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(within(section).queryByText("web/src/a.ts:1")).toBeNull();
  });

  // #313: a review entry is a single minimal line — verdict, author and time — with the body left
  // to the Commits section's review dialog.
  it("renders a review as a one-line entry without its body", async () => {
    renderDetail();

    const section = (
      await screen.findByRole("heading", {
        name: "Comments (2)",
      })
    ).closest("section")!;
    expect(within(section).getByText("passed")).toBeTruthy();
    expect(within(section).queryByText("LGTM")).toBeNull();
  });

  // #300/#307: the activity entries (commits and reviews) connect along a vertical
  // line, the same pattern the workflow run history uses — but a conversation comment breaks the
  // line and renders as its own card, not on it.
  it("connects activity entries with a vertical line and leaves comments off it", async () => {
    renderDetail();

    const section = (
      await screen.findByRole("heading", {
        name: "Comments (2)",
      })
    ).closest("section")!;
    // The fixture's two comments split the activity into two runs: commits bbbb → review, then
    // commit aaaa (newest); the line comment is excluded from the timeline.
    const lists = within(section).getAllByRole("list");
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list.className).toContain("border-l");
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.className).toContain("relative");
      expect(item.querySelector("span.absolute.rounded-full")).toBeTruthy();
    }
    // The conversation comments are cards outside the line — no listitem, no dot.
    expect(
      section.querySelectorAll('[data-debug-component="PullComment"]'),
    ).toHaveLength(2);
  });

  it("shows zero in the Comments heading when there are no comments", async () => {
    renderDetail({ "comments/list": () => [] });

    expect(
      await screen.findByRole("heading", { name: "Comments (0)" }),
    ).toBeTruthy();
  });

  it("updates the Comments heading count after a comment is posted", async () => {
    let serverComments = [...comments];
    renderDetail({
      "comments/list": () => serverComments,
      "pullComments/create": (params: { body: string }) => {
        const comment: IssueComment = {
          id: 10,
          user: { login: "me" },
          author_type: "human",
          body: params.body,
          created_at: "2026-06-18T12:00:00Z",
          reactions: [],
        };
        serverComments = [...serverComments, comment];
        return comment;
      },
    });

    const composer = await screen.findByLabelText("Add a PR comment");
    fireEvent.change(composer, { target: { value: "One more thing." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Comments (3)" }),
      ).toBeTruthy();
    });
  });

  // #2129: a human post reads as @human whatever actor name it was stored under; agent posts keep
  // their own author.
  it("shows a human PR comment as @human and leaves an agent comment alone", async () => {
    renderDetail();

    const human = (await screen.findByText("Thanks!")).closest("article");
    expect(human?.textContent).toContain("@human");
    expect(human?.textContent).not.toContain("@me");
    expect(
      within(human as HTMLElement).queryByLabelText("AI agent"),
    ).toBeNull();

    const agent = screen.getByText("Rebased on main.").closest("article");
    expect(agent?.textContent).toContain("@impl-bot");
    expect(
      within(agent as HTMLElement).getByLabelText("AI agent"),
    ).toBeTruthy();
  });

  it("shows a PR comment before the request settles and reconciles it once", async () => {
    let resolveCreate!: () => void;
    let serverComments = [...comments];
    const listComments = vi.fn(() => serverComments);
    const pending = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    renderDetail({
      "comments/list": listComments,
      "pullComments/create": async (params) => {
        await pending;
        const comment: IssueComment = {
          id: 10,
          user: { login: "me" },
          author_type: "human",
          body: params.body,
          created_at: "2026-06-18T12:00:00Z",
          reactions: [],
        };
        serverComments = [...serverComments, comment];
        return comment;
      },
    });

    const composer = await screen.findByLabelText("Add a PR comment");
    fireEvent.change(composer, { target: { value: "Please rename this." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      expect(rpcCall("pullComments/create")?.params).toEqual({
        repo: "me/proj",
        number: 30,
        body: "Please rename this.",
      });
      expect((composer as HTMLTextAreaElement).value).toBe("");
      expect(screen.getAllByText("Please rename this.")).toHaveLength(1);
    });

    resolveCreate();
    await waitFor(() => {
      expect(listComments).toHaveBeenCalledTimes(2);
      expect(screen.getAllByText("Please rename this.")).toHaveLength(1);
    });
  });

  it("posts a non-empty PR comment once with Cmd+Enter but not Enter alone", async () => {
    let resolveCreate!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const create = vi.fn(async (params: { body: string }) => {
      await pending;
      return {
        id: 10,
        user: { login: "me" },
        author_type: "human" as const,
        body: params.body,
        created_at: "2026-06-18T12:00:00Z",
        reactions: [],
      };
    });
    renderDetail({ "pullComments/create": create });

    const composer = (await screen.findByLabelText(
      "Add a PR comment",
    )) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: "   " } });
    expect(fireEvent.keyDown(composer, { key: "Enter", metaKey: true })).toBe(
      false,
    );
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(composer, { target: { value: "Keyboard comment" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(create).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(composer, { key: "Enter", metaKey: true })).toBe(
      false,
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Keyboard comment" }),
    );
    expect(composer.value).toBe("");

    fireEvent.change(composer, { target: { value: "Second comment" } });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    expect(create).toHaveBeenCalledTimes(1);

    resolveCreate();
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  it("restores the PR comment composer and cache when posting fails", async () => {
    let rejectCreate!: (error: RpcFault) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject;
    });
    renderDetail({
      "pullComments/create": () => pending,
    });

    const composer = await screen.findByLabelText("Add a PR comment");
    fireEvent.change(composer, { target: { value: "Please retry this." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      expect((composer as HTMLTextAreaElement).value).toBe("");
      expect(screen.getByText("Please retry this.")).toBeTruthy();
    });

    rejectCreate(new RpcFault(500, "write failed"));
    await waitFor(() => {
      expect(screen.getAllByText("Please retry this.")).toHaveLength(1);
      expect((composer as HTMLTextAreaElement).value).toBe(
        "Please retry this.",
      );
      expect(screen.getByText("Failed to post comment.")).toBeTruthy();
    });
  });

  it("keeps the detail loading while the initial comment list is pending", async () => {
    const commentsPending = new Promise<never>(() => {});
    const listComments = vi.fn(() => commentsPending);
    renderDetail({
      "comments/list": listComments,
    });

    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByLabelText("Add a PR comment")).toBeNull();
  });

  it("renders PR comments in response order before the comment form", async () => {
    renderDetail({
      "comments/list": () => [
        comments[0],
        {
          ...comments[0],
          id: 10,
          body: "Second comment",
        },
      ],
    });

    const firstComment = await screen.findByText("Thanks!");
    const secondComment = screen.getByText("Second comment");
    const composer = screen.getByLabelText("Add a PR comment");
    const firstCommentCard = firstComment.closest("article")!;
    const secondCommentCard = secondComment.closest("article")!;
    const firstAuthor = within(firstCommentCard).getByText("@human");
    const firstTime = firstCommentCard.querySelector("time")!;
    const firstId = within(firstCommentCard).getByLabelText("Comment ID 9");

    expect(firstTime.getAttribute("datetime")).toBe("2026-06-18T11:45:00Z");
    expect(firstId.textContent).toBe("#9");
    expect(firstId.classList).toContain("ml-auto");
    expect(
      firstAuthor.compareDocumentPosition(firstTime) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      firstTime.compareDocumentPosition(firstId) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(secondCommentCard).getByLabelText("Comment ID 10").textContent,
    ).toBe("#10");

    expect(
      firstComment.compareDocumentPosition(secondComment) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      secondComment.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the empty comments state before the comment form", async () => {
    // No commits/reviews/line comments either, so the whole timeline is empty and the section has
    // nothing but its "No comments." placeholder and the composer.
    renderDetail({
      "pulls/get": () => ({ ...pull, commits: [] }),
      "reviews/list": () => [],
      "reviews/listComments": () => [],
      "comments/list": () => [],
    });

    const emptyState = await screen.findByText("No comments.");
    const composer = screen.getByLabelText("Add a PR comment");

    expect(
      emptyState.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("expands and shrinks the PR comment composer with its content", async () => {
    renderDetail({ "comments/list": () => [] });

    const composer = (await screen.findByLabelText(
      "Add a PR comment",
    )) as HTMLTextAreaElement;
    expect(composer.className).toContain("min-h-24");
    let scrollHeight = 144;
    Object.defineProperty(composer, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    fireEvent.change(composer, {
      target: { value: "A comment that wraps onto several displayed lines." },
    });
    expect(composer.style.height).toBe("144px");
    expect(composer.className).toContain("resize-none");
    expect(composer.className).toContain("overflow-hidden");

    scrollHeight = 72;
    fireEvent.change(composer, { target: { value: "Short comment" } });
    expect(composer.style.height).toBe("72px");
  });

  it("shows reactions attached to PR comments", async () => {
    renderDetail({
      "comments/list": () => [
        {
          ...comments[0],
          reactions: [{ emoji: "👀", count: 1, reacted: false }],
        },
      ],
    });

    expect(await screen.findByLabelText("👀 reaction: 1")).toBeTruthy();
  });

  it("optimistically adds, changes, and removes a PR comment reaction", async () => {
    let serverReactions = [{ emoji: "👍", count: 2, reacted: false }];
    let resolveReact!: (comment: IssueComment) => void;
    const react = vi.fn(
      () =>
        new Promise<IssueComment>((resolve) => {
          resolveReact = (comment) => {
            serverReactions = comment.reactions;
            resolve(comment);
          };
        }),
    );
    const listComments = vi.fn(() => [
      { ...comments[0], reactions: serverReactions },
    ]);
    renderDetail({
      "comments/list": listComments,
      "pullComments/react": react,
    });

    await screen.findByLabelText("Add reaction to PR comment 9");
    fireEvent.pointerDown(
      screen.getByLabelText("Add reaction to PR comment 9"),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "React to PR comment 9 with 🎉",
      }),
    );

    const added = await screen.findByLabelText("🎉 reaction: 1");
    expect(added.getAttribute("aria-pressed")).toBe("true");
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 9, emoji: "🎉" }),
    );
    resolveReact({
      ...comments[0],
      reactions: [
        { emoji: "👍", count: 2, reacted: false },
        { emoji: "🎉", count: 1, reacted: true },
      ],
    });
    await waitFor(() => expect(listComments).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("👍 reaction: 2") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByLabelText("👍 reaction: 2"));
    await waitFor(() => {
      expect(screen.queryByLabelText("🎉 reaction: 1")).toBeNull();
      expect(
        screen.getByLabelText("👍 reaction: 3").getAttribute("aria-pressed"),
      ).toBe("true");
    });
    resolveReact({
      ...comments[0],
      reactions: [{ emoji: "👍", count: 3, reacted: true }],
    });
    await waitFor(() => {
      expect(listComments).toHaveBeenCalledTimes(3);
      expect(
        (screen.getByLabelText("👍 reaction: 3") as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByLabelText("👍 reaction: 3"));
    await waitFor(() =>
      expect(screen.getByLabelText("👍 reaction: 2")).toBeTruthy(),
    );
    resolveReact({
      ...comments[0],
      reactions: [{ emoji: "👍", count: 2, reacted: false }],
    });
    await waitFor(() => {
      expect(listComments).toHaveBeenCalledTimes(4);
      expect(
        screen.getByLabelText("👍 reaction: 2").getAttribute("aria-pressed"),
      ).toBe("false");
    });
  });

  it("rolls back a failed PR comment reaction and shows the error", async () => {
    let rejectReact!: (error: RpcFault) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectReact = reject;
    });
    renderDetail({
      "pullComments/react": () => pending,
    });

    await screen.findByLabelText("Add reaction to PR comment 9");
    fireEvent.pointerDown(
      screen.getByLabelText("Add reaction to PR comment 9"),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "React to PR comment 9 with 🎉",
      }),
    );
    expect(await screen.findByLabelText("🎉 reaction: 1")).toBeTruthy();

    rejectReact(new RpcFault(500, "write failed"));
    await waitFor(() => {
      expect(screen.queryByLabelText("🎉 reaction: 1")).toBeNull();
      expect(screen.getByText("Reaction failed: write failed")).toBeTruthy();
    });
  });

  it("archives a PR comment from its three dots menu", async () => {
    const archive = vi.fn(() => ({
      ...comments[0],
      archived_at: "2026-06-18T12:00:00Z",
    }));
    renderDetail({ "pullComments/archive": archive });

    fireEvent.pointerDown(
      await screen.findByLabelText("Actions for PR comment 9"),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 9, archived: true }),
      ),
    );
  });

  it("copies a PR comment's markdown from its three dots menu", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderDetail();

    fireEvent.pointerDown(
      await screen.findByLabelText("Actions for PR comment 9"),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy as Markdown" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Thanks!"));
  });

  it("collapses an archived PR comment and expands it on demand", async () => {
    const archive = vi.fn(() => ({ ...comments[0], archived_at: null }));
    renderDetail({
      "comments/list": () => [
        { ...comments[0], archived_at: "2026-06-18T12:00:00Z" },
      ],
      "pullComments/archive": archive,
    });

    const summary = await screen.findByLabelText("Archived PR comment 9");
    expect(summary.textContent).toContain("me: Thanks!");
    expect(screen.queryByLabelText("Add reaction to PR comment 9")).toBeNull();

    fireEvent.click(summary);
    expect(screen.getByLabelText("Add reaction to PR comment 9")).toBeTruthy();

    fireEvent.pointerDown(screen.getByLabelText("Actions for PR comment 9"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 9, archived: false }),
      ),
    );
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
      "PullBody",
      "PullCommitsSection",
      "PullCommitRow",
      "FilesChanged",
      "FileSummaryRow",
      "PullCommentList",
      "PullSidebar",
      "PullInfoSection",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  // #59: the section tabs are in-page anchors, so every section they link to keeps its place on
  // the one page — following a tab moves the scroll position and nothing else.
  it("puts the tabs under the PR header, anchored to sections that all stay rendered", async () => {
    const { container } = renderDetail();

    await screen.findByText("ui2: PR detail");
    const mainContent = container.querySelector<HTMLElement>(
      '[data-debug-component="PullMainContent"]',
    );
    const tabs = container.querySelector<HTMLElement>(
      '[data-debug-component="PullSectionTabs"]',
    );
    // The content stack runs header → tabs → the sections the tabs navigate, so the PR's title and
    // status stay above the bar and everything it links to stays below it.
    expect(
      Array.from(
        mainContent?.lastElementChild?.children ?? [],
        (child) => (child as HTMLElement).dataset.debugComponent,
      ).slice(0, 3),
    ).toEqual(["PullHeader", "PullSectionTabs", "PullBody"]);
    expect(
      Array.from(tabs?.querySelectorAll("a") ?? [], (link) => [
        link.textContent,
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Overview", "#overview"],
      ["Commits", "#commits"],
      ["Files changed", "#files-changed"],
      ["Comments", "#comments"],
    ]);
    for (const [id, component] of [
      ["overview", "PullHeader"],
      ["commits", "PullCommitsSection"],
      ["files-changed", "FilesChanged"],
      ["comments", "PullCommentList"],
    ]) {
      const section = container.querySelector<HTMLElement>(`#${id}`);
      expect(section?.dataset.debugComponent).toBe(component);
      // Anchored sections land below the tab bar as well as the sticky header.
      expect(section?.className).toContain("scroll-mt-11");
    }
  });

  // #2089: the sticky header is the main column's own first child, so its sticky box — and with it
  // the bar's width — follows the main content instead of spanning the sidebar too.
  it("anchors the sticky header to the main column, not the full page width", async () => {
    const { container } = renderDetail();

    await screen.findByText("ui2: PR detail");
    const mainContent = container.querySelector<HTMLElement>(
      '[data-debug-component="PullMainContent"]',
    );
    const sidebar = container.querySelector<HTMLElement>(
      '[data-debug-component="PullSidebar"]',
    );
    expect(mainContent?.firstElementChild?.className).toContain("sticky");
    expect(sidebar).not.toBeNull();
    expect(mainContent?.contains(sidebar as Node)).toBe(false);
  });

  // #2348: the sidebar stays in view while the main column scrolls, but only in the two-column
  // layout — every sticky class is `lg:`-gated so the stacked layout keeps the normal flow.
  it("sticks the sidebar below the sticky header only beside the main column", async () => {
    const { container } = renderDetail();

    await screen.findByText("ui2: PR detail");
    const sidebar = container.querySelector<HTMLElement>(
      '[data-debug-component="PullSidebar"]',
    );
    const classes = sidebar?.className.split(/\s+/) ?? [];
    expect(classes).toContain("lg:sticky");
    expect(classes).toContain("lg:top-5");
    expect(classes.filter((c) => c.includes("sticky"))).toEqual(["lg:sticky"]);
    // The row must keep aligning its columns to the start: stretched to the row's height, the
    // sidebar has no room left to slide within and sticky silently becomes a no-op.
    expect(sidebar?.parentElement?.className).toContain("lg:items-start");
  });

  // #59: the header above the section tabs is the title and its status only — authorship, the
  // branch pair and the linked issue are the sidebar's job now, so they read once per page.
  it("keeps the header to the title and status, with the basics only in the sidebar", async () => {
    const { container } = renderDetail();

    await screen.findByText("ui2: PR detail");
    const header = container.querySelector<HTMLElement>(
      '[data-debug-component="PullHeader"]',
    )!;
    expect(within(header).getByRole("heading", { level: 1 })).toBeTruthy();
    expect(within(header).getByText("mergeable")).toBeTruthy();
    expect(within(header).queryByText(/opened/)).toBeNull();
    expect(within(header).queryByText(/wants to merge/)).toBeNull();
    expect(within(header).queryByText(/Linked issue/)).toBeNull();
    expect(within(header).queryByText("issue-153")).toBeNull();
    expect(within(header).queryByText("main")).toBeNull();
  });

  it("shows a regular PR author with the opened time in the sidebar", async () => {
    renderDetail();

    const section = (
      await screen.findByRole("heading", { name: "PR details" })
    ).closest("section")!;
    expect(within(section).getByText("Opened")).toBeTruthy();
    expect(within(section).getByText("@impl-bot")).toBeTruthy();
  });

  it("hides a Workflow-generated PR author without removing the opened time", async () => {
    renderDetail({
      "pulls/get": () => ({
        ...pull,
        user: { login: "Workflow #153 ui2: PR detail" },
      }),
    });

    await screen.findByText("ui2: PR detail");
    expect(screen.queryByText(/@Workflow #153/)).toBeNull();
    const section = screen
      .getByRole("heading", { name: "PR details" })
      .closest("section")!;
    expect(within(section).getByText("Opened")).toBeTruthy();
    expect(within(section).getByText("issue-153")).toBeTruthy();
    expect(within(section).getByText("main")).toBeTruthy();
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

  // #1908, moved to the sidebar with the header's branch pair (#59): the base branch stays
  // copyable, symmetrically with the head branch.
  it("copies the base branch from the sidebar with visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderDetail();

    fireEvent.click(
      await screen.findByRole("button", { name: "Copy base branch" }),
    );

    expect(writeText).toHaveBeenCalledWith("main");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy(),
    );
  });

  // #2406 / #2435: the sidebar's first section carries Worktree, Branch (head→base), and Linked
  // issue only — no Head SHA and no separate Head/Base rows.
  it("shows the PR basics in the sidebar with copy actions for the worktree path and head branch", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const worktreePath = "/Users/me/.loophub/worktrees/me/proj/pr-30";
    renderDetail({
      "pulls/get": () => ({ ...pull, worktree_path: worktreePath }),
    });

    const section = (
      await screen.findByRole("heading", { name: "PR details" })
    ).closest("section")!;
    expect(within(section).getByText("Worktree")).toBeTruthy();
    expect(within(section).getByText("Branch")).toBeTruthy();
    expect(within(section).getByText("Linked issue")).toBeTruthy();
    expect(within(section).queryByText("Head branch")).toBeNull();
    expect(within(section).queryByText("Base branch")).toBeNull();
    expect(within(section).queryByText("Head SHA")).toBeNull();
    expect(within(section).getByText(worktreePath)).toBeTruthy();
    expect(within(section).getByText("issue-153")).toBeTruthy();
    expect(within(section).getByText("main")).toBeTruthy();
    expect(within(section).getByText("→")).toBeTruthy();
    expect(within(section).queryByText("aaa")).toBeNull();
    expect(within(section).getByRole("link", { name: "#153" })).toBeTruthy();
    expect(
      within(section).getByText("ui2: PR list + detail + merged"),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        within(section).getByRole("button", { name: "Copy worktree path" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith(worktreePath);

    await act(async () => {
      fireEvent.click(
        within(section).getByRole("button", { name: "Copy head branch" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith("issue-153");
  });

  it("shows an unavailable worktree row without an empty copy action, keeping the other basics", async () => {
    renderDetail();

    const section = (
      await screen.findByRole("heading", { name: "PR details" })
    ).closest("section")!;
    expect(within(section).getByText("Unavailable")).toBeTruthy();
    expect(
      within(section).queryByRole("button", { name: "Copy worktree path" }),
    ).toBeNull();
    expect(within(section).getByText("Branch")).toBeTruthy();
    expect(within(section).getByText("issue-153")).toBeTruthy();
    expect(within(section).getByText("main")).toBeTruthy();
  });

  it("omits the linked issue row for a PR without one", async () => {
    renderDetail({ "pulls/get": () => ({ ...pull, linked_issue: null }) });

    const section = (
      await screen.findByRole("heading", { name: "PR details" })
    ).closest("section")!;
    expect(within(section).queryByText("Linked issue")).toBeNull();
    expect(within(section).getByText("Branch")).toBeTruthy();
    expect(within(section).getByText("issue-153")).toBeTruthy();
    expect(within(section).getByText("main")).toBeTruthy();
  });

  // #2406: a long issue title must not stretch the fixed-width sidebar — it truncates on one line
  // and keeps its full text in the tooltip.
  it("truncates a long linked issue title in the sidebar and keeps the full text on hover", async () => {
    const title =
      `A very long linked issue title ${"that keeps going ".repeat(10)}`.trim();
    renderDetail({
      "pulls/get": () => ({
        ...pull,
        linked_issue: { ...pull.linked_issue!, title },
      }),
    });

    const section = (
      await screen.findByRole("heading", { name: "PR details" })
    ).closest("section")!;
    const titleElement = within(section).getByText(title);
    expect(titleElement.className).toContain("truncate");
    expect(titleElement.getAttribute("title")).toBe(title);
  });

  // #2406: the basics lead the sidebar, above the Workflow section.
  it("orders the sidebar with the PR details section first", async () => {
    const { container } = renderDetail();

    await screen.findByRole("heading", { name: "PR details" });
    const sidebar = container.querySelector<HTMLElement>(
      '[data-debug-component="PullSidebar"]',
    )!;
    expect(
      sidebar.firstElementChild?.getAttribute("data-debug-component"),
    ).toBe("PullInfoSection");
  });

  it("does not render an independent Work duration section", async () => {
    renderDetail();

    await screen.findByRole("heading", { name: "PR details" });
    expect(screen.queryByRole("heading", { name: "Work duration" })).toBeNull();
  });

  it("does not render an independent Reviews section", async () => {
    renderDetail();

    await screen.findByRole("heading", {
      name: /Files changed \(1\)/,
    });
    expect(screen.getByLabelText("File status: modified")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Reviews" })).toBeNull();
  });

  it("shows each changed file as status, trailing filename, and changes on one row", async () => {
    renderDetail();

    await screen.findByRole("heading", { name: /Files changed \(1\)/ });
    const filename = screen.getByText("web/src/a.ts");
    const row = filename.closest("button")!;
    expect(Array.from(row.children).map((child) => child.textContent)).toEqual([
      "M",
      "web/src/a.ts",
      "+1−1",
      "",
    ]);
    expect(row.className).toContain("grid-cols-");
    expect(filename.className).toContain("truncate");
    expect(filename.className).toContain("font-mono");
    expect(filename.className).toContain("text-xs");
    expect(filename.className).toContain("[direction:rtl]");
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
    // An empty timeline (no commits/reviews/line comments either) so "No comments." renders.
    renderDetail({
      "pulls/get": () => ({ ...pull, commits: [] }),
      "reviews/list": () => [],
      "reviews/listComments": () => [],
      "comments/list": () => [],
    });

    const heading = await screen.findByRole("heading", {
      name: "Comments (0)",
    });
    const commentsSection = heading.closest("section");

    expect(commentsSection?.className).toContain("pb-6");
    expect(commentsSection?.textContent).toContain("No comments.");
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

  it("allows Merge while an agent linked to the PR is working", async () => {
    renderDetail({
      "terminal/sessions": () => ({
        repos: [
          {
            repo: "me/proj",
            session_name: "me-proj",
            agents: [
              {
                id: "w1:p1",
                name: "executor #7-1",
                status: "working",
                pull: 30,
                pull_closed: false,
                focusable: true,
              },
            ],
            pull_workspaces: [],
            issue_workspaces: [],
          },
        ],
      }),
    });

    const button = await screen.findByRole("button", { name: /^Merge$/i });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    expect(button.getAttribute("title")).toBeNull();
  });

  it("allows Merge while agent status is loading", async () => {
    renderDetail({
      "terminal/sessions": () => new Promise(() => {}),
    });

    const button = await screen.findByRole("button", { name: /^Merge$/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("title")).toBeNull();
  });

  it("allows Merge when agent status cannot be loaded", async () => {
    renderDetail({
      "terminal/sessions": () => {
        throw new RpcFault(500, "agent status unavailable");
      },
    });

    const button = await screen.findByRole("button", { name: /^Merge$/i });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(button.getAttribute("title")).toBeNull();
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

  it("groups reviews under matching commits and omits superseded commit reviews", async () => {
    // One review matches a listed commit; the other targets a commit outside base..head.
    const grouped: PullReview[] = [
      {
        id: 2,
        user: { login: "design-bot" },
        author_type: "agent",
        state: "REQUEST_CHANGES",
        body: "needs work",
        head_sha: "old1234deadbeef",
        submitted_at: "2026-06-18T10:00:00Z",
        duration_seconds: null,
        ac_results: [],
      },
      {
        id: 1,
        user: { login: "design-bot" },
        author_type: "agent",
        state: "PASS",
        body: "LGTM now",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T11:30:00Z",
        duration_seconds: null,
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

    // The superseded review stays out of the commit rows, but the comment timeline still lists it
    // in its chronological place as its minimal one-liner (#145, #313): the verdict, not the body.
    expect(screen.queryByText("old1234")).toBeNull();
    expect(within(currentGroup).queryByText("needs work")).toBeNull();
    expect(screen.queryByText("needs work")).toBeNull();
    expect(screen.getByText("changes requested")).toBeTruthy();
  });

  it("omits every review when none targets a listed commit", async () => {
    const grouped: PullReview[] = [
      {
        id: 1,
        user: { login: "design-bot" },
        author_type: "agent",
        state: "REQUEST_CHANGES",
        body: "older feedback",
        head_sha: "older12",
        submitted_at: "2026-06-18T09:00:00Z",
        duration_seconds: null,
        ac_results: [],
      },
      {
        id: 2,
        user: { login: "design-bot" },
        author_type: "agent",
        state: "REQUEST_CHANGES",
        body: "newest feedback",
        head_sha: "newer34",
        submitted_at: "2026-06-18T10:00:00Z",
        duration_seconds: null,
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

    await screen.findByRole("button", {
      name: "View changes in aaaaaaa: Latest change",
    });
    const currentGroup = screen
      .getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      })
      .closest("li")!;
    // No review is grouped under a commit — the row reads "Not reviewed", and no dialog exists.
    expect(within(currentGroup).queryByText("Reviewed")).toBeNull();
    expect(screen.queryByText("Reviews for unknown commits")).toBeNull();
    // The reviews still surface in the comment timeline, just not grouped under a commit (#145),
    // as their minimal one-liner: the verdict badge, not the body (#313).
    expect(screen.queryByText("newest feedback")).toBeNull();
    expect(screen.queryByText("older feedback")).toBeNull();
    expect(screen.getAllByText("changes requested")).toHaveLength(2);
  });

  it("resolves a group's verdict from the latest review, so a later PASS clears an earlier REQUEST_CHANGES (#533)", async () => {
    // Round 1: REQUEST_CHANGES against the current head. Round 2: a later PASS
    // against the same head resolves it.
    const grouped: PullReview[] = [
      {
        id: 1,
        user: { login: "quality-bot" },
        author_type: "agent",
        state: "REQUEST_CHANGES",
        body: "round 1: needs work",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T10:00:00Z",
        duration_seconds: null,
        ac_results: [],
      },
      {
        id: 2,
        user: { login: "security-bot" },
        author_type: "agent",
        state: "PASS",
        body: "security ok",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T10:05:00Z",
        duration_seconds: null,
        ac_results: [],
      },
      {
        id: 3,
        user: { login: "quality-bot" },
        author_type: "agent",
        state: "PASS",
        body: "round 2: looks good now",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T11:00:00Z",
        duration_seconds: null,
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
        author_type: "agent",
        state: "PASS",
        body: "security ok",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T10:00:00Z",
        duration_seconds: null,
        ac_results: [],
      },
      {
        id: 2,
        user: { login: "quality-bot" },
        author_type: "agent",
        state: "REQUEST_CHANGES",
        body: "still needs work",
        head_sha: pull.commits![0].sha,
        submitted_at: "2026-06-18T10:05:00Z",
        duration_seconds: null,
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

  it("does not show a sidebar Agents section when a herdr session runs this PR", async () => {
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
                focusable: true,
              },
            ],
            pull_workspaces: [{ pull: 30, pane_id: "%3", status: "working" }],
            issue_workspaces: [],
          },
        ],
      }),
    });

    await screen.findByRole("button", { name: /^Merge$/i });
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(screen.queryByText("dev #30")).toBeNull();
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
          },
        ],
      }),
    });

    await screen.findByText("ui2: PR detail");
    expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Handoffs" })).toBeNull();
    expect(rpcCall("handoffs/list")).toBeUndefined();
  });

  it("shows Workflow in the sidebar with Detail access", async () => {
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
                focusable: true,
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
        current_step: "verify",
        rework_count: 2,
        rework_limit: 8,
        needs_human_reason: "Review the unexpected API change",
        issue_number: 153,
        pr_number: 30,
        created_at: "2026-06-18T11:00:00Z",
        updated_at: "2026-06-18T12:00:00Z",
        latest_review: null,
      }),
      "workflowRuns/totalCost": () => ({
        cost_usd: 1.75,
        cost_status: "known",
      }),
    });

    await screen.findByText("Implementation loop");
    const workflowHeading = screen.getByRole("heading", { name: "Workflow" });
    expect(workflowHeading.closest("aside")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(screen.getByText("Implementation loop")).toBeTruthy();
    expect(screen.getByText("run 12")).toBeTruthy();
    expect(screen.getByText("Verify")).toBeTruthy();
    expect(screen.getByText("Rework: 2/8")).toBeTruthy();
    expect(screen.getByText("Total cost")).toBeTruthy();
    expect(screen.getByText("$1.75")).toBeTruthy();
    expect(screen.getByText("Needs human")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detail" })).toBeTruthy();
  });

  it("increases an over-budget Workflow run from the PR page", async () => {
    let increased = false;
    const held = {
      id: 12,
      workflow_id: 3,
      workflow_name: "Implementation loop",
      status: "running",
      current_step: "execute",
      rework_count: 0,
      rework_limit: 8,
      needs_human_reason: "Cost limit exceeded",
      issue_number: 153,
      pr_number: 30,
      created_at: "2026-06-18T11:00:00Z",
      updated_at: "2026-06-18T12:00:00Z",
      latest_review: null,
      verification_status: "unverified",
      cost_limit_usd: 20,
      cost_increment_usd: 10,
      cost_limit_increase_available: true,
    };
    renderDetail({
      "workflowRuns/stateForPull": () =>
        increased
          ? {
              ...held,
              cost_limit_usd: 30,
              cost_limit_increase_available: false,
            }
          : held,
      "workflowRuns/increaseCostLimit": () => {
        increased = true;
        return {
          run: 12,
          increment_usd: 10,
          previous_limit_usd: 20,
          current_limit_usd: 30,
        };
      },
    });

    fireEvent.focus(await screen.findByText("over budget"));
    const prompt = screen.getByRole("group", { name: "Increase to $30.00?" });
    await act(async () => {
      fireEvent.click(within(prompt).getByRole("button", { name: "Yes" }));
    });

    expect(rpcCall("workflowRuns/increaseCostLimit")?.params).toMatchObject({
      repo: "me/proj",
      run: 12,
      expected_limit_usd: 20,
    });
    expect(screen.queryByText("Needs human")).toBeNull();
    expect(screen.queryByText("needs human")).toBeNull();
  });

  it("shows a new human wait reason after increasing the budget", async () => {
    let increased = false;
    const held = {
      id: 12,
      workflow_id: 3,
      workflow_name: "Implementation loop",
      status: "running",
      current_step: "execute",
      rework_count: 0,
      rework_limit: 8,
      needs_human_reason: "Cost limit exceeded",
      issue_number: 153,
      pr_number: 30,
      created_at: "2026-06-18T11:00:00Z",
      updated_at: "2026-06-18T12:00:00Z",
      latest_review: null,
      verification_status: "unverified",
      cost_limit_usd: 20,
      cost_increment_usd: 10,
      cost_limit_increase_available: true,
    };
    renderDetail({
      "workflowRuns/stateForPull": () =>
        increased
          ? {
              ...held,
              cost_limit_usd: 30,
              cost_limit_increase_available: false,
              needs_human_reason: "waiting for a decision",
            }
          : held,
      "workflowRuns/increaseCostLimit": () => {
        increased = true;
        return {
          run: 12,
          increment_usd: 10,
          previous_limit_usd: 20,
          current_limit_usd: 30,
        };
      },
    });

    fireEvent.focus(await screen.findByText("over budget"));
    const prompt = screen.getByRole("group", { name: "Increase to $30.00?" });
    await act(async () => {
      fireEvent.click(within(prompt).getByRole("button", { name: "Yes" }));
    });

    expect(await screen.findByText("Needs human")).toBeTruthy();
    expect(screen.getByText("waiting for a decision")).toBeTruthy();
  });

  it("shows no budget action for a Workflow run that is within budget", async () => {
    renderDetail({
      "workflowRuns/stateForPull": () => ({
        id: 12,
        workflow_id: 3,
        workflow_name: "Implementation loop",
        status: "running",
        current_step: "execute",
        rework_count: 0,
        rework_limit: 8,
        needs_human_reason: null,
        issue_number: 153,
        pr_number: 30,
        created_at: "2026-06-18T11:00:00Z",
        updated_at: "2026-06-18T12:00:00Z",
        latest_review: null,
        verification_status: "unverified",
        cost_limit_usd: 20,
        cost_increment_usd: 10,
        cost_limit_increase_available: false,
      }),
    });

    await screen.findByText("Implementation loop");
    expect(screen.queryByText("over budget")).toBeNull();
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
        rework_limit: 8,
        needs_human_reason: null,
        issue_number: 153,
        pr_number: 30,
        created_at: "2026-06-18T11:00:00Z",
        updated_at: "2026-06-18T12:00:00Z",
        latest_review: null,
        verification_status: "verified",
        done: true,
        merge_conflict: false,
      }),
    });

    await screen.findByText("Implementation loop");
    expect(screen.getByText("Ready to merge")).toBeTruthy();
    expect(
      screen.getByText("Verify passed for the current HEAD."),
    ).toBeTruthy();
    expect(screen.getByText("Verify")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detail" })).toBeTruthy();
    expect(screen.queryByText(/continuing/i)).toBeNull();
  });

  it("hides Workflow run when none is linked", async () => {
    renderDetail({ "workflowRuns/stateForPull": () => null });
    await screen.findByText("ui2: PR detail");
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Workflow" })).toBeNull(),
    );
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
// pull so we can exercise each mode without touching the shared fixture. A function override is
// re-read on every fetch, so a test can change what the server reports and refetch (#2383).
function renderDetailWithPull(
  override: Partial<PullRequest> | (() => Partial<PullRequest>),
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  const current = () =>
    typeof override === "function" ? override() : override;
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "pulls/get": () => ({ ...pull, ...current() }),
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
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    queryClient,
  };
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

  it("appends the repository extra prompt when Create PR on GitHub launches (#2422)", async () => {
    renderDetailWithPull(
      { merge_mode: "github_pr", github_pull: null },
      {
        "repos/githubPrExportExtraPrompt": () => ({
          extra_prompt: "Prefer type/short-slug branch names.",
        }),
      },
    );
    const button = await screen.findByRole("button", {
      name: /Create PR on GitHub/i,
    });
    // Wait for the extra-prompt query to resolve before launching so the click sees the text.
    await waitFor(() => {
      expect(rpcCall("repos/githubPrExportExtraPrompt")).toBeTruthy();
    });
    fireEvent.click(button);
    const opts = launchTerminal.mock.calls[0][0];
    expect(opts.prompt).toContain("lh pr create-github-pr 30 --repo me/proj");
    expect(opts.prompt).toContain("Prefer type/short-slug branch names.");
    expect(opts.prompt.endsWith("Prefer type/short-slug branch names.")).toBe(
      true,
    );
  });

  it("drops the Create action once exported and links to GitHub from the sidebar section (#2035)", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: linkedGithubPull(null),
    });
    // The only route to the GitHub PR is the link in the sidebar's GitHub PR section body (#2091) —
    // the action row has no "View PR on GitHub" button anymore.
    const link = await screen.findByRole("link", { name: "me/proj/pull/7" });
    expect(link.getAttribute("href")).toBe("https://github.com/me/proj/pull/7");
    expect(screen.queryByText(/View PR on GitHub/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Create PR on GitHub/i }),
    ).toBeNull();
  });

  // #2383: the export runs in a launched agent, so the button has to report progress itself —
  // otherwise it snaps back to looking unpressed and invites a second launch.
  it("goes into a loading state on click and stays there until the export lands", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: null,
      github_pr_export_started_at: null,
    });
    const button = (await screen.findByRole("button", {
      name: /Create PR on GitHub/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    const creating = (await screen.findByRole("button", {
      name: /Creating…/i,
    })) as HTMLButtonElement;
    expect(creating.disabled).toBe(true);
    expect(
      screen.queryByRole("button", { name: /Create PR on GitHub/i }),
    ).toBeNull();
    // A second click can't dispatch another export.
    fireEvent.click(creating);
    expect(launchTerminal).toHaveBeenCalledTimes(1);
  });

  it("renders the loading state on load for an export already running", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: null,
      github_pr_export_started_at: new Date().toISOString(),
    });
    const creating = (await screen.findByRole("button", {
      name: /Creating…/i,
    })) as HTMLButtonElement;
    expect(creating.disabled).toBe(true);
  });

  it("leaves the loading state behind once the GitHub PR is recorded", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: linkedGithubPull(null),
      github_pr_export_started_at: new Date().toISOString(),
    });
    // github_pull present means the export landed: the action row is the push control again, with
    // no in-progress Create button left over.
    await screen.findByRole("button", { name: /Push to GitHub/i });
    expect(screen.queryByRole("button", { name: /Creating…/i })).toBeNull();
  });

  // Unlinking is how an operator asks to export again (#2384), and it patches the cached PR in
  // place rather than remounting the action — so the click that started the export it just dropped
  // must not be what the returning Create button reports on.
  it("returns a clickable Create button after the export lands and is unlinked", async () => {
    let override: Partial<PullRequest> = {
      merge_mode: "github_pr",
      github_pull: null,
      github_pr_export_started_at: null,
    };
    const { queryClient } = renderDetailWithPull(() => override);

    fireEvent.click(
      await screen.findByRole("button", { name: /Create PR on GitHub/i }),
    );
    await screen.findByRole("button", { name: /Creating…/i });

    // The export lands.
    override = { ...override, github_pull: linkedGithubPull(null) };
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await screen.findByRole("button", { name: /Push to GitHub/i });

    // The operator unlinks it to export again. The server reports no outstanding export.
    override = {
      ...override,
      title: "Unlinked to export again",
      github_pull: null,
    };
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await screen.findByRole("heading", {
      name: "Unlinked to export again",
      level: 1,
    });

    const again = screen.getByRole("button", {
      name: /Create PR on GitHub/i,
    }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
  });

  // Nothing writes back a *failed* export, so the loading state is bounded by a TTL instead of
  // hanging forever on an agent that died.
  it("returns to a clickable button when the export never lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: null,
      github_pr_export_started_at: new Date().toISOString(),
    });
    await screen.findByRole("button", { name: /Creating…/i });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GITHUB_PR_EXPORT_PENDING_TTL_MS + 1000);
    });

    const button = (await screen.findByRole("button", {
      name: /Create PR on GitHub/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  // A start can arrive already expired — the events poll pauses while the tab is hidden, so the
  // first payload after it comes back can describe an export that ran out long ago. The button must
  // judge it against the current clock, not against whenever the page happened to mount.
  it("ignores a start that is already past its TTL when it arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mountedAt = Date.now();
    let override: Partial<PullRequest> = {
      merge_mode: "github_pr",
      github_pull: null,
      github_pr_export_started_at: null,
    };
    const { queryClient } = renderDetailWithPull(() => override);
    const button = (await screen.findByRole("button", {
      name: /Create PR on GitHub/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    // The export started shortly before the page mounted and has since run out; the payload only
    // reaches the page now. Its expiry is still after the mount, so a mount-time clock would call it
    // in progress with no timer left to ever end it. The title changes with it, so the assertion
    // below can only run once this payload has actually reached the page.
    override = {
      ...override,
      title: "Export that ran out",
      github_pr_export_started_at: new Date(
        mountedAt - GITHUB_PR_EXPORT_PENDING_TTL_MS + 60_000,
      ).toISOString(),
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GITHUB_PR_EXPORT_PENDING_TTL_MS);
      await queryClient.invalidateQueries();
    });
    await screen.findByRole("heading", {
      name: "Export that ran out",
      level: 1,
    });

    const stillClickable = screen.getByRole("button", {
      name: /Create PR on GitHub/i,
    }) as HTMLButtonElement;
    expect(stillClickable.disabled).toBe(false);
  });

  // The optimistic half of the loading state is local to the button, and the detail route is reused
  // across a client-side navigation — so it has to be tied to the PR it was started for.
  // Both shapes matter: one detail route serves every repo, and PR numbers are per repo, so
  // "another PR" can differ by number, by repo, or both.
  it.each([
    ["another PR in the same repo", { repo: "proj", number: 31 }],
    ["the same PR number in another repo", { repo: "other", number: 30 }],
  ] as const)("does not carry the loading state onto %s", async (_case, other) => {
    const started = { repo: "proj", number: 30 };
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/get": (params: any) => ({
          ...pull,
          number: params.number,
          title: `${params.repo} PR ${params.number}`,
          merge_mode: "github_pr",
          github_pull: null,
          github_pr_export_started_at: null,
        }),
        "pulls/files": () => files,
        "reviews/list": () => reviews,
        "reviews/listComments": () => lineComments,
        "comments/list": () => comments,
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function SwitchingDetail() {
      const [showOther, setShowOther] = useState(true);
      const shown = showOther ? other : started;
      return (
        <>
          <button type="button" onClick={() => setShowOther((v) => !v)}>
            open the other PR
          </button>
          <PullDetail owner="me" repo={shown.repo} number={shown.number} />
        </>
      );
    }
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <SwitchingDetail />,
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

    // `pulls/get` is called with the full "owner/name", which is what the stub echoes into the title.
    const heading = (pr: { repo: string; number: number }) =>
      `me/${pr.repo} PR ${pr.number}`;

    // Visit the other PR first so its detail is cached: coming back to it renders straight from the
    // cache with no loading gap, which is exactly when the route is reused rather than remounted.
    await screen.findByRole("heading", { name: heading(other), level: 1 });
    fireEvent.click(screen.getByRole("button", { name: /open the other PR/i }));
    await screen.findByRole("heading", { name: heading(started), level: 1 });

    fireEvent.click(
      await screen.findByRole("button", { name: /Create PR on GitHub/i }),
    );
    await screen.findByRole("button", { name: /Creating…/i });

    fireEvent.click(screen.getByRole("button", { name: /open the other PR/i }));

    await screen.findByRole("heading", { name: heading(other), level: 1 });
    const button = (await screen.findByRole("button", {
      name: /Create PR on GitHub/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  // A launch the server refused started no agent, so there is nothing to wait for: the operator must
  // be able to retry right away rather than sit out the TTL.
  it("drops the loading state when the launch itself fails", async () => {
    launchTerminal.mockImplementation(() => {
      launchState.failed = true;
    });
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: null,
      github_pr_export_started_at: null,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /Create PR on GitHub/i }),
    );

    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: /Create PR on GitHub/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    expect(screen.queryByRole("button", { name: /Creating…/i })).toBeNull();
  });

  it.each([
    "github_pr",
    "merge",
  ] as const)("offers Mark as merged after GitHub merge detection in %s mode and invokes the dedicated action", async (mergeMode) => {
    renderDetailWithPull(
      {
        merge_mode: mergeMode,
        github_pull: {
          ...linkedGithubPull(null),
          github_merged: true,
          github_merged_at: "2026-07-15T00:00:00Z",
        },
      },
      {
        "pulls/markGithubMerged": () => ({
          merged: true,
          merged_at: "2026-07-15T00:00:00Z",
        }),
      },
    );

    expect(
      await screen.findByRole("button", { name: /^Close$/i }),
    ).toBeTruthy();
    const button = screen.getByRole("button", { name: /Mark as merged/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(rpcCall("pulls/markGithubMerged")?.params).toMatchObject({
        repo: "me/proj",
        number: 30,
      });
    });
    expect(rpcCall("pulls/merge")).toBeUndefined();
  });

  it.each([
    ["merge not detected", { github_pull: linkedGithubPull(null) }],
    [
      "missing the detected merge time",
      {
        github_pull: {
          ...linkedGithubPull(null),
          github_merged: true,
          github_merged_at: null,
        },
      },
    ],
    ["closed", { state: "closed" as const }],
    ["already merged", { state: "closed" as const, merged: true }],
  ])("omits Mark as merged when the PR is %s", async (_label, override) => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: {
        ...linkedGithubPull(null),
        github_merged: true,
        github_merged_at: "2026-07-15T00:00:00Z",
      },
      ...override,
    });

    await screen.findByText("ui2: PR detail");
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

// #2394: a linked-PR row's comment count links here with the `#comments` hash. The section only
// exists once the page's data has loaded, so the page brings it into view itself.
describe("PullDetail — #comments landing (#2394)", () => {
  async function commentsSection() {
    const heading = await screen.findByRole("heading", {
      name: /^Comments \(/,
    });
    return heading.closest("section");
  }

  it("scrolls the Comments section into view when the page opens on #comments", async () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    renderDetail({}, ["/#comments"]);

    const section = await commentsSection();
    expect(section?.id).toBe("comments");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.instances[0]).toBe(section);
  });

  it("leaves the page where it is without the hash", async () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    renderDetail();

    await commentsSection();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
