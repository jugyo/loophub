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
  DiffFeedbackThread,
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
    author_type: "agent",
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
  },
  {
    id: 11,
    user: { login: "impl-bot" },
    author_type: "agent",
    body: "Rebased on main.",
    created_at: "2026-06-18T11:50:00Z",
    reactions: [],
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
    renderDetail();

    expect(await screen.findByText("ui2: PR detail")).toBeTruthy();
    expect(screen.getByText("issue-153")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("Render diff, reviews, comments.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Develop" })).toBeNull();

    // The existing file summary opens its diff in a dialog instead of expanding inline.
    expect(await screen.findByText("web/src/a.ts")).toBeTruthy();
    expect(screen.queryByText("const x = 1;")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /web\/src\/a\.ts/i }));
    const fileDialog = await screen.findByRole("dialog", {
      name: /Diff for web\/src\/a\.ts/i,
    });
    expect(within(fileDialog).getByText("const x = 1;")).toBeTruthy();
    expect(within(fileDialog).getByLabelText("New line 1")).toBeTruthy();
    expect(
      within(fileDialog).getByRole("button", { name: "Split" }),
    ).toBeTruthy();
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

  it("links the PR header to the comments section", async () => {
    const { container } = renderDetail({
      "pulls/get": () => ({ ...pull, comments: 3 }),
    });

    const commentsLink = await screen.findByRole("link", {
      name: "Comments (3)",
    });
    expect(commentsLink.getAttribute("href")).toBe("#comments");
    act(() => commentsLink.focus());
    expect(document.activeElement).toBe(commentsLink);
    expect(
      container.querySelector('[data-debug-component="PullCommentList"]')?.id,
    ).toBe("comments");
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
    renderDetail({ "comments/list": () => [] });

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
      "FileSummaryRow",
      "PullCommentList",
      "PullSidebar",
      "WorktreeSection",
    ]) {
      expect(names.has(name)).toBe(true);
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
    renderDetail({ "comments/list": () => [] });

    const heading = await screen.findByRole("heading", { name: "Comments" });
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

    expect(screen.queryByText("old1234")).toBeNull();
    expect(screen.queryByText("needs work")).toBeNull();
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
    expect(screen.queryByText("Reviews for unknown commits")).toBeNull();
    expect(screen.queryByText("newer34")).toBeNull();
    expect(screen.queryByText("older12")).toBeNull();
    expect(screen.queryByText("newest feedback")).toBeNull();
    expect(screen.queryByText("older feedback")).toBeNull();
    expect(screen.queryByText("current")).toBeNull();
    expect(screen.queryByText("changes requested")).toBeNull();
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
    });

    await screen.findByText("Implementation loop");
    const workflowHeading = screen.getByRole("heading", { name: "Workflow" });
    expect(workflowHeading.closest("aside")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(screen.getByText("Implementation loop")).toBeTruthy();
    expect(screen.getByText("run 12")).toBeTruthy();
    expect(screen.getByText("Verify")).toBeTruthy();
    expect(screen.getByText("· rework ×2/8")).toBeTruthy();
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
                focusable: true,
                workflow: {
                  kind: "step",
                  runId: 12,
                  step: currentStep,
                  sequence: 1,
                },
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
        rework_limit: 8,
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
