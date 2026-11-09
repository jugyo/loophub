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
import { afterEach, describe, expect, it, vi } from "#loophub-test";
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

const stickyRoomRestorers: (() => void)[] = [];

import { WebConfigProvider } from "@/lib/web-config";
import { commentIdFromHash, PullDetail } from "./pull-detail";
import { ToastProvider, ToastViewport } from "./toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  launchTerminal.mockReset();
  launchState.failed = false;
  for (const restore of stickyRoomRestorers.splice(0)) restore();
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
    passed_scope: "full",
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

const representativeDiffs = {
  "web/src/a.ts": {
    language: "typescript" as const,
    oldText: "const value = 0;",
    newText: "const value = 1;",
    token: "keyword" as const,
  },
  "web/src/a.js": {
    language: "javascript" as const,
    oldText: "const value = 0;",
    newText: "const value = 1;",
    token: "keyword" as const,
  },
  "docs/a.md": {
    language: "markdown" as const,
    oldText: "# Before",
    newText: "# After",
    token: "markup" as const,
  },
};

function representativeDiff(path: keyof typeof representativeDiffs) {
  const sample = representativeDiffs[path];
  const patch = `@@ -1 +1 @@\n-${sample.oldText}\n+${sample.newText}`;
  return {
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    files: [
      {
        path,
        absolute_path: `/repo/${path}`,
        original_path: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch,
        syntax_highlight: {
          language: sample.language,
          lines: [
            { old: null, new: null },
            {
              old: [{ kind: sample.token, text: sample.oldText }],
              new: null,
            },
            {
              old: null,
              new: [{ kind: sample.token, text: sample.newText }],
            },
          ],
        },
        lines: [
          {
            kind: "hunk" as const,
            text: "@@ -1 +1 @@",
            left_line: null,
            right_line: null,
            syntax_highlight: { old: null, new: null },
          },
          {
            kind: "deletion" as const,
            text: `-${sample.oldText}`,
            left_line: 1,
            right_line: null,
            syntax_highlight: {
              old: [{ kind: sample.token, text: sample.oldText }],
              new: null,
            },
          },
          {
            kind: "addition" as const,
            text: `+${sample.newText}`,
            left_line: null,
            right_line: 1,
            syntax_highlight: {
              old: null,
              new: [{ kind: sample.token, text: sample.newText }],
            },
          },
        ],
      },
    ],
  };
}

const reviews: PullReview[] = [
  {
    id: 1,
    user: { login: "design-bot" },
    author_type: "agent",
    state: "PASS",
    body: "LGTM",
    head_sha: pull.commits![0].sha,
    base_sha: null,
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
    resolved_anchor: {
      path: "web/src/a.ts",
      original_path: null,
      side: "RIGHT",
      start_line: 1,
      end_line: 1,
    },
    outdated_reason: null,
    placement: "inline",
    original_context: null,
    archived_at: null,
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
    "repos/commitHistory": () => pull.commits ?? [],
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
      unpushed_commits: 0,
      unpulled_commits: 0,
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
  { debug = false }: { debug?: boolean } = {},
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
      <WebConfigProvider config={{ debug }}>
        <ToastProvider>
          <ToastViewport />
          <main data-debug-component="RouteContent">
            <PullDetail owner="me" repo="proj" number={30} />
          </main>
        </ToastProvider>
      </WebConfigProvider>
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

// The file list lives in the right pane, behind its icon rail.
async function findFilesChangedHeading(name: RegExp) {
  const rail = await screen.findByRole("navigation", {
    name: "Right pane views",
  });
  const button = within(rail).getByRole("button", { name: "Files changed" });
  if (button.getAttribute("aria-pressed") !== "true") fireEvent.click(button);
  const back = screen.queryByRole("button", { name: "Back to file list" });
  if (back) fireEvent.click(back);
  return screen.findByRole("heading", { name });
}

// The Commits view is behind the right pane's icon rail; the pane starts on Files changed.
async function openCommitsView() {
  const rail = await screen.findByRole("navigation", {
    name: "Right pane views",
  });
  fireEvent.click(within(rail).getByRole("button", { name: "Commits" }));
}

// The tracks of a Tailwind `grid-cols-[...]` class, split on the top-level `_` separators so a
// track that carries its own underscores (`minmax(0,_max-content)`) still counts as one.
function gridTemplateColumns(className: string): string[] {
  const template = className.match(/grid-cols-\[([^\]]+)\]/)?.[1];
  if (!template) throw new Error(`no grid-cols-[...] class in: ${className}`);
  const tracks: string[] = [];
  let depth = 0;
  let track = "";
  for (const char of template) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "_" && depth === 0) {
      tracks.push(track);
      track = "";
      continue;
    }
    track += char;
  }
  tracks.push(track);
  return tracks;
}

describe("PullDetail", () => {
  it("初期 pageData から Diff View の token 描画までを代表3形式で計測する", async () => {
    const paths = Object.keys(representativeDiffs) as Array<
      keyof typeof representativeDiffs
    >;
    const summaryFiles = paths.map((path) => {
      const summary: PullFile = {
        filename: path,
        status: "modified",
        additions: 1,
        deletions: 1,
      };
      return summary;
    });
    const pendingResolvers = new Map<
      string,
      (value: ReturnType<typeof representativeDiff>) => void
    >();
    const timings = new Map<
      string,
      {
        queryStartedAt: number;
        apiStartedAt: number;
        patchTokenCompletedAt: number;
        renderCompletedAt: number;
      }
    >();
    const getDiff = vi.fn(({ path }: { path: string }) => {
      const timing = timings.get(path);
      if (!timing) throw new Error(`unexpected diff path: ${path}`);
      timing.apiStartedAt = performance.now();
      return new Promise<ReturnType<typeof representativeDiff>>((resolve) => {
        pendingResolvers.set(path, (value) => {
          timing.patchTokenCompletedAt = performance.now();
          resolve(value);
        });
      });
    });

    renderDetail({
      "pulls/files": () => summaryFiles,
      "pulls/diff": getDiff,
    });

    await findFilesChangedHeading(/Files changed \(3\)/);
    expect(getDiff).not.toHaveBeenCalled();

    for (const path of paths) {
      timings.set(path, {
        queryStartedAt: performance.now(),
        apiStartedAt: 0,
        patchTokenCompletedAt: 0,
        renderCompletedAt: 0,
      });
      await findFilesChangedHeading(/Files changed \(3\)/);
      fireEvent.click(
        screen.getByRole("button", {
          name: new RegExp(
            `File status: modified ${path.replaceAll(".", "\\.")}`,
          ),
        }),
      );
      await waitFor(() =>
        expect(getDiff).toHaveBeenCalledWith(expect.objectContaining({ path })),
      );
      expect(screen.getByText("Loading diff…")).toBeTruthy();

      pendingResolvers.get(path)?.(representativeDiff(path));
      const sample = representativeDiffs[path];
      await waitFor(() => {
        const dialog = screen.getByRole("region", { name: /^Diff for/ });
        expect(
          dialog.querySelector(`[data-syntax-language="${sample.language}"]`),
        ).toBeTruthy();
        expect(
          dialog.querySelector(`[data-syntax-token="${sample.token}"]`),
        ).toBeTruthy();
      });
      const timing = timings.get(path)!;
      timing.renderCompletedAt = performance.now();
      expect(timing.apiStartedAt).toBeGreaterThanOrEqual(timing.queryStartedAt);
      expect(timing.patchTokenCompletedAt).toBeGreaterThanOrEqual(
        timing.apiStartedAt,
      );
      expect(timing.renderCompletedAt).toBeGreaterThanOrEqual(
        timing.patchTokenCompletedAt,
      );

      console.info(
        `Diff View の計測 ${path}: query=${(
          timing.apiStartedAt - timing.queryStartedAt
        ).toFixed(1)}ms, API=${(
          timing.patchTokenCompletedAt - timing.apiStartedAt
        ).toFixed(1)}ms, render=${(
          timing.renderCompletedAt - timing.patchTokenCompletedAt
        ).toFixed(1)}ms`,
      );
    }
  });

  it("passes the pull range to the file commit history query", async () => {
    const commitHistory = vi.fn(() => pull.commits ?? []);
    renderDetail({
      "pulls/diff": ({ path }: { path: string }) => representativeDiff(path),
      "repos/commitHistory": commitHistory,
    });

    await findFilesChangedHeading(/Files changed/);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /File status: modified web\/src\/a\.ts/,
      }),
    );
    await waitFor(() =>
      expect(commitHistory).toHaveBeenCalledWith({
        repo: "me/proj",
        base: "bbb",
        head: "aaa",
        path: "web/src/a.ts",
      }),
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Select diff scope" }),
      { button: 0, ctrlKey: false },
    );
    expect(
      await screen.findByRole("menuitem", { name: /Latest change/ }),
    ).toBeTruthy();
  });

  it("shows a file's last change time before its comment count", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-18T14:00:00Z"));
    renderDetail({
      "pulls/files": () => [
        { ...files[0], last_changed_at: "2026-06-18T12:00:00Z" },
      ],
      "diffFeedback/list": () => ({
        threads: [],
        comment_counts: { "web/src/a.ts": 2 },
      }),
    });

    const section = (
      await findFilesChangedHeading(/Files changed \(1\)/)
    ).closest("section")!;
    const commentCount = within(section).getByLabelText("2 comments");
    const changedAt = within(section).getByText("2h ago");
    expect(changedAt.compareDocumentPosition(commentCount)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(section).getByText("·")).toBeTruthy();
  });

  it("hides viewed files behind a count and shows them back on request", async () => {
    renderDetail({
      "pulls/files": () => [
        { ...files[0], last_changed_sha: "a".repeat(40) },
        {
          ...files[0],
          filename: "web/src/b.ts",
          last_changed_sha: "b".repeat(40),
        },
      ],
      "pullFileViews/list": () => [
        {
          path: "web/src/a.ts",
          sha: "a".repeat(40),
          viewed_at: "2026-06-18T13:00:00Z",
        },
      ],
    });

    const section = (
      await findFilesChangedHeading(/Files changed \(2\)/)
    ).closest("section")!;
    expect(
      within(section).queryByRole("button", { name: /web\/src\/a\.ts/ }),
    ).toBeNull();
    expect(
      within(section).getByRole("button", { name: /web\/src\/b\.ts/ }),
    ).toBeTruthy();

    const toggle = within(section).getByRole("switch", {
      name: "Show viewed",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(within(section).getByText(/Show viewed \(1 viewed\)/)).toBeTruthy();

    fireEvent.click(toggle);
    const viewedRow = within(section).getByRole("button", {
      name: /web\/src\/a\.ts/,
    });
    expect(within(viewedRow).getByLabelText("Viewed")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // The count is about the record, not about what the toggle is holding back, so it stays put.
    expect(within(section).getByText(/Show viewed \(1 viewed\)/)).toBeTruthy();
  });

  it("selects the next file after marking the open file viewed", async () => {
    renderDetail({
      "pulls/files": () => [
        { ...files[0], last_changed_sha: "a".repeat(40) },
        {
          ...files[0],
          filename: "web/src/b.ts",
          last_changed_sha: "b".repeat(40),
        },
      ],
      "pullFileViews/set": () => [
        {
          path: files[0].filename,
          sha: "a".repeat(40),
          viewed_at: "2026-08-23T12:00:00Z",
        },
      ],
    });

    const section = (
      await findFilesChangedHeading(/Files changed \(2\)/)
    ).closest("section")!;
    const fileSummaryList = section.querySelector<HTMLElement>(
      '[data-debug-component="FileSummaryRow"]',
    )?.parentElement;
    if (!fileSummaryList) throw new Error("File summary list not found");
    fireEvent.click(
      within(fileSummaryList).getByRole("button", {
        name: /web\/src\/a\.ts/,
      }),
    );
    expect(
      await screen.findByRole("region", { name: /Diff for/ }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed" }));

    const dialog = await screen.findByRole("region", {
      name: "Diff for web/src/b.ts",
    });
    expect(dialog).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "web/src/a.ts" }),
      ).toBeNull();
      expect(
        screen.getByRole("heading", { name: "web/src/b.ts" }),
      ).toBeTruthy();
      const summaryRows = Array.from(
        fileSummaryList.querySelectorAll<HTMLElement>(
          '[data-debug-component="FileSummaryRow"]',
        ),
      );
      expect(summaryRows).toHaveLength(1);
      expect(summaryRows[0]?.textContent).toContain("b.ts");
    });
  });

  it("brings a file back with a label once new commits land on it", async () => {
    renderDetail({
      "pulls/files": () => [{ ...files[0], last_changed_sha: "b".repeat(40) }],
      "pullFileViews/list": () => [
        {
          path: "web/src/a.ts",
          sha: "a".repeat(40),
          viewed_at: "2026-06-18T13:00:00Z",
        },
      ],
    });

    const section = (
      await findFilesChangedHeading(/Files changed \(1\)/)
    ).closest("section")!;
    const row = within(section).getByRole("button", {
      name: /web\/src\/a\.ts/,
    });
    expect(within(row).getByLabelText("Changed since viewed")).toBeTruthy();
    expect(
      within(section).getByRole("switch", { name: "Show viewed" }),
    ).toBeTruthy();
    expect(within(section).getByText(/Show viewed \(0 viewed\)/)).toBeTruthy();
  });

  it("gives the file row's trailing metadata a column of its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-18T14:00:00Z"));
    renderDetail({
      "pulls/files": () => [
        { ...files[0], last_changed_at: "2026-06-18T12:00:00Z" },
      ],
      "diffFeedback/list": () => ({
        threads: [],
        comment_counts: { "web/src/a.ts": 2 },
      }),
    });

    const section = (
      await findFilesChangedHeading(/Files changed \(1\)/)
    ).closest("section")!;
    const row = within(section).getByRole("button", {
      name: /web\/src\/a\.ts/,
    });
    // The time, its separator and the comment count are optional, so the row keeps them in one
    // cell: as separate children they outnumber the columns and wrap onto an implicit second row.
    const meta = within(section).getByText("2h ago").parentElement!;
    expect(meta.parentElement).toBe(row);
    expect(within(meta).getByLabelText("2 comments")).toBeTruthy();
    // One child per track, so that cell is the last track — which must be content-sized. A
    // flexible track collapses to zero once a long filename takes the row's free space, and the
    // nowrap metadata then overflows onto the diff stat.
    const tracks = gridTemplateColumns(row.className);
    expect(row.children.length).toBe(tracks.length);
    expect(tracks.at(-1)).not.toMatch(/fr\b/);
  });

  it("keeps the file row unchanged when its last change time is unavailable", async () => {
    renderDetail();

    const section = (
      await findFilesChangedHeading(/Files changed \(1\)/)
    ).closest("section")!;
    const row = within(section).getByRole("button", {
      name: /web\/src\/a\.ts/,
    });
    expect(row).toBeTruthy();
    expect(within(row).queryByText(/ago$/)).toBeNull();
  });

  it("shows the button when the scrollport grows after the initial render", async () => {
    const resizeCallbacks = new Map<Element, () => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          this.callback = callback;
        }
        callback: () => void;
        observe(target: Element) {
          resizeCallbacks.set(target, this.callback);
        }
        disconnect() {}
      },
    );
    const { container } = renderDetail();
    await findFilesChangedHeading(/Files changed/);
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-debug-component="PullLeftColumn"]',
    );
    if (!scrollContainer) throw new Error("Scroll container not found");
    const timeline = container.querySelector<HTMLElement>(
      '[data-debug-component="PullMainContent"]',
    );
    if (!timeline) throw new Error("Timeline not found");
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
      left: 100,
      width: 800,
    } as DOMRect);
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, value: 0 },
    });

    act(() => resizeCallbacks.get(scrollContainer)?.());

    const button = await screen.findByRole("button", {
      name: "ページ下部へ移動",
    });
    expect(button).toBeTruthy();
    expect(button.style.left).toBe("500px");
    expect(button.style.transform).toBe("translateX(-50%)");
  });

  it("rechecks the scrollport when content is inserted after the initial render", async () => {
    let notifyMutation: (() => void) | undefined;
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: () => void) {
          notifyMutation = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { container } = renderDetail();
    await findFilesChangedHeading(/Files changed/);
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-debug-component="PullLeftColumn"]',
    );
    if (!scrollContainer) throw new Error("Scroll container not found");
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, value: 0 },
    });

    act(() => notifyMutation?.());

    expect(
      await screen.findByRole("button", { name: "ページ下部へ移動" }),
    ).toBeTruthy();
  });

  it("shows a button away from the bottom and scrolls to the page bottom", async () => {
    const { container } = renderDetail();
    await findFilesChangedHeading(/Files changed/);
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-debug-component="PullLeftColumn"]',
    );
    if (!scrollContainer) throw new Error("Scroll container not found");
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, value: 100 },
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scrollContainer, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    fireEvent.scroll(scrollContainer);

    const button = await screen.findByRole("button", {
      name: "ページ下部へ移動",
    });
    // Clear of the status bar and the terminal dock above it, whose height is unset (so 0) when
    // the screen has no dock.
    expect(button.className).toContain(
      "bottom-[calc(3rem+var(--pull-terminal-dock-height,0px))]",
    );
    fireEvent.click(button);
    expect(scrollTo).toHaveBeenCalledWith({
      top: 1200,
      behavior: "smooth",
    });
  });

  it("hides the button at the page bottom and updates after scrolling", async () => {
    const { container } = renderDetail();
    await findFilesChangedHeading(/Files changed/);
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-debug-component="PullLeftColumn"]',
    );
    if (!scrollContainer) throw new Error("Scroll container not found");
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, value: 600, writable: true },
    });
    fireEvent.scroll(scrollContainer);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "ページ下部へ移動" }),
      ).toBeNull(),
    );

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
    });
    fireEvent.scroll(scrollContainer);
    expect(
      await screen.findByRole("button", { name: "ページ下部へ移動" }),
    ).toBeTruthy();
  });

  it("shows diff comment counts in the file list and diff sidebar", async () => {
    renderDetail({
      "diffFeedback/list": () => ({
        threads: diffFeedback,
        comment_counts: { "web/src/a.ts": 2 },
      }),
    });

    const filesChanged = await findFilesChangedHeading(/Files changed \(1\)/);
    const section = filesChanged.closest("section");
    if (!section) throw new Error("Files changed section not found");
    expect(await within(section).findByLabelText("2 comments")).toBeTruthy();

    fireEvent.click(
      within(section).getByRole("button", { name: /web\/src\/a\.ts/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Show diff full screen" }),
    );
    const sidebar = await screen.findByRole("complementary", {
      name: "Changed files",
    });
    expect(within(sidebar).getByLabelText("2 comments")).toBeTruthy();
    expect(
      Array.from(
        within(sidebar).getByRole("button", { name: "web/src/a.ts" }).children,
      ).map((child) => child.textContent),
    ).toEqual(["M", "a.ts", "+1−1", "", "2"]);
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

    const filesChanged = await findFilesChangedHeading(/Files changed \(1\)/);
    const section = filesChanged.closest("section");
    if (!section) throw new Error("Files changed section not found");
    expect(await within(section).findByLabelText("2 comments")).toBeTruthy();
    fireEvent.click(
      within(section).getByRole("button", { name: "Previous diff threads" }),
    );
    expect(await within(section).findByText("First comment")).toBeTruthy();
    expect(rpcCall("diffFeedback/list")).toBeFalsy();
  });

  // Resolving has no optimistic update and emits no event, so the page query is what has to
  // refetch — the previous-threads list it seeds would otherwise sit on the pre-resolve value
  // and the action would look like it did nothing (#123).
  it("shows a previous thread as resolved after resolving it", async () => {
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

    const filesChanged = await findFilesChangedHeading(/Files changed \(1\)/);
    const section = filesChanged.closest("section");
    if (!section) throw new Error("Files changed section not found");
    fireEvent.click(
      within(section).getByRole("button", { name: "Previous diff threads" }),
    );
    const card = await within(section).findByLabelText("Diff thread 1");
    fireEvent.click(within(card).getByRole("button", { name: "Resolve" }));

    expect(
      await within(section).findByLabelText("Resolved diff thread 1"),
    ).toBeTruthy();
  });

  it("says beside Merge when the passing review was partial (#2538)", async () => {
    renderDetailWithPull({
      review_gate: {
        reviewed: true,
        passed: true,
        head_sha: "aaa",
        blocking_reason: null,
        passed_scope: "partial",
      },
    });

    expect(await screen.findByText(/Passed on a partial review/)).toBeTruthy();
  });

  it("drops the partial-pass note once the PR is merged (#2538)", async () => {
    renderDetailWithPull({
      state: "closed",
      merged: true,
      mergeable_state: "merged",
      review_gate: {
        reviewed: true,
        passed: true,
        head_sha: "aaa",
        blocking_reason: null,
        passed_scope: "partial",
      },
    });

    expect(await screen.findByText("ui2: PR detail")).toBeTruthy();
    expect(screen.queryByText(/partial review/)).toBeNull();
  });

  it("leaves the merge action unqualified after a full pass (#2538)", async () => {
    renderDetailWithPull({});

    expect(await screen.findByRole("button", { name: "Merge" })).toBeTruthy();
    expect(screen.queryByText(/Passed on a partial review/)).toBeNull();
  });

  it("does not offer a ready action after changes are requested", async () => {
    renderDetailWithPull({
      review_state: "CHANGES_REQUESTED",
      review_gate: {
        reviewed: true,
        passed: false,
        head_sha: "aaa",
        blocking_reason: "request_changes",
        passed_scope: null,
      },
    });

    expect(await screen.findByText("changes")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Mark ready for re-review" }),
    ).toBeNull();
  });

  it("labels the header's title as the linked issue's, apart from the PR's own number", async () => {
    const { container } = renderDetail();

    await screen.findByText("ui2: PR detail");
    const header = container.querySelector<HTMLElement>(
      '[data-debug-component="DetailHeaderTitle"]',
    )!;
    expect(header.textContent).toContain("PR #30 · title from Issue #153");
    expect(
      within(header)
        .getByRole("link", { name: "Issue #153" })
        .getAttribute("href"),
    ).toBe("/r/me/proj/issues/153");
  });

  it("renders title, base←head, file summary, reviews, and comments", async () => {
    const { container } = renderDetail();

    expect(await screen.findByText("ui2: PR detail")).toBeTruthy();
    expect(document.title).toBe("PR #30 · ui2: PR detail · me/proj · LoopHub");
    // Branch names are scoped to the info band above the Evidence, the one place they appear.
    const details = container.querySelector<HTMLElement>(
      '[data-debug-component="PullInfoSection"]',
    )!;
    expect(within(details).getByText("issue-153")).toBeTruthy();
    expect(within(details).getByText("main")).toBeTruthy();
    expect(screen.getByText("Render diff, reviews, comments.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Develop" })).toBeNull();

    // The file summary opens its diff in the right pane's Diff view.
    const filesSection = (
      await findFilesChangedHeading(/Files changed \(1\)/)
    ).closest("section")!;
    expect(await within(filesSection).findByText("web/src/a.ts")).toBeTruthy();
    expect(screen.queryByText("const x = 1;")).toBeNull();
    fireEvent.click(
      within(filesSection).getByRole("button", {
        name: /web\/src\/a\.ts/i,
      }),
    );
    const fileDialog = await screen.findByRole("region", {
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
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Right pane views" }),
      ).getByRole("button", { name: "Commits" }),
    );
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
    fireEvent.click(
      within(reviewDialog).getByRole("button", { name: "Show details" }),
    );
    expect(within(reviewDialog).getByText("LGTM")).toBeTruthy();
    // Review model tag (#1107).
    expect(within(reviewDialog).getByText("claude-opus-4-8")).toBeTruthy();
    // Line comment.
    expect(within(reviewDialog).getByText("nice constant")).toBeTruthy();
    // Issue comment.
    expect(screen.getByText("Thanks!")).toBeTruthy();
  });

  it.each([
    ["open fallback", { review_state: null, mergeable_state: "unknown" }],
    ["merged", { merged: true }],
    ["closed", { state: "closed" }],
    [
      "changes + conflict",
      { review_state: "CHANGES_REQUESTED", mergeable_state: "conflict" },
    ],
    [
      "over budget",
      { cost_stopped: true, review_state: null, mergeable_state: "unknown" },
    ],
  ] as const)("keeps %s status labels out of the page title", async (_case, override) => {
    renderDetailWithPull(override);

    await screen.findByText("ui2: PR detail");
    expect(document.title).toBe("PR #30 · ui2: PR detail · me/proj · LoopHub");
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

  it("diff feedback のタイムライン項目から対象ファイルを開く", async () => {
    renderDetail({
      "diffFeedback/list": () => ({
        threads: diffFeedback,
        comment_counts: { "web/src/a.ts": 2 },
      }),
    });

    const section = (
      await screen.findByRole("heading", { name: "Comments (2)" })
    ).closest("section")!;
    const entry = within(section).getByRole("button", {
      name: "Comment: web/src/a.ts",
    });
    expect(within(entry).getByText("Comment")).toBeTruthy();
    expect(within(entry).getByText("web/src/a.ts")).toBeTruthy();
    expect(within(entry).queryByText("First comment")).toBeNull();

    fireEvent.click(entry);

    const dialog = await screen.findByRole("region", {
      name: "Diff for web/src/a.ts",
    });
    expect(await within(dialog).findByLabelText("Diff thread 1")).toBeTruthy();
  });

  // #2488: only the newest page of the timeline is on screen; "Load more" — above the entries,
  // where the older ones belong — unfolds the rest a page at a time.
  it("shows the newest 20 timeline items and unfolds older ones a page at a time", async () => {
    const manyCommits = Array.from({ length: 45 }, (_, index) => ({
      sha: `${String(index + 1).padStart(2, "0")}${"a".repeat(38)}`,
      author: "impl-bot",
      // pull.commits is newest first, so commit 1 is the newest and commit 45 the oldest.
      date: `2026-06-${String(45 - index).padStart(2, "0")}T12:00:00Z`,
      subject: `Timeline commit ${index + 1}`,
    }));
    renderDetail({
      "pulls/get": () => ({ ...pull, commits: manyCommits }),
      "comments/list": () => [],
      "reviews/list": () => [],
    });

    const section = (
      await screen.findByRole("heading", { name: "Comments (0)" })
    ).closest("section")!;
    expect(within(section).getAllByRole("listitem")).toHaveLength(20);
    expect(within(section).getByText("Timeline commit 1")).toBeTruthy();
    expect(within(section).getByText("Timeline commit 20")).toBeTruthy();
    expect(within(section).queryByText("Timeline commit 21")).toBeNull();

    const loadMore = within(section).getByRole("button", { name: "Load more" });
    expect(
      loadMore.compareDocumentPosition(
        within(section).getAllByRole("listitem")[0],
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(loadMore);
    expect(within(section).getAllByRole("listitem")).toHaveLength(40);
    expect(within(section).getByText("Timeline commit 40")).toBeTruthy();
    expect(within(section).queryByText("Timeline commit 41")).toBeNull();

    fireEvent.click(within(section).getByRole("button", { name: "Load more" }));
    expect(within(section).getAllByRole("listitem")).toHaveLength(45);
    expect(within(section).getByText("Timeline commit 45")).toBeTruthy();
    expect(
      within(section).queryByRole("button", { name: "Load more" }),
    ).toBeNull();
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

  // #2500: GitHub-side activity sits in the same chronological list as the LoopHub entries, marked
  // as GitHub's and linking to the item on GitHub.
  it("renders GitHub activity in the timeline with links out to GitHub", async () => {
    const githubUrl = "https://github.com/upstream/proj/pull/7";
    renderDetail({
      "fixture/pullGithubActivity": () => [
        {
          kind: "github_activity",
          created_at: "2026-06-18T11:47:00Z",
          github_activity: {
            type: "issue_comment",
            github_number: 7,
            github_id: 501,
            url: `${githubUrl}#issuecomment-501`,
            author: "octocat",
            review_state: null,
          },
        },
        {
          kind: "github_activity",
          created_at: "2026-06-18T11:55:00Z",
          github_activity: {
            type: "review",
            github_number: 7,
            github_id: 502,
            url: `${githubUrl}#pullrequestreview-502`,
            author: "reviewer",
            review_state: "changes_requested",
          },
        },
        // Observed before the display fields were recorded: no author, and the link falls back to
        // the PR itself.
        {
          kind: "github_activity",
          created_at: "2026-06-18T11:58:00Z",
          github_activity: {
            type: "merged",
            github_number: 7,
            github_id: null,
            url: githubUrl,
            author: null,
            review_state: null,
          },
        },
      ],
    });

    const section = (
      await screen.findByRole("heading", { name: "Comments (2)" })
    ).closest("section")!;
    const commented = within(section).getByText("Commented on GitHub");
    expect(commented.closest("a")?.getAttribute("href")).toBe(
      `${githubUrl}#issuecomment-501`,
    );
    expect(within(section).getByText("@octocat")).toBeTruthy();
    expect(within(section).getByText("changes requested")).toBeTruthy();
    expect(
      within(section)
        .getByText("Merged on GitHub")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe(githubUrl);

    // The GitHub entries land between the LoopHub entries they follow and precede.
    const order = [
      "Thanks!",
      "Commented on GitHub",
      "Rebased on main.",
      "Reviewed on GitHub",
      "Merged on GitHub",
      "Latest change",
    ];
    const nodes = order.map((text) => within(section).getByText(text));
    for (let index = 0; index < nodes.length - 1; index += 1) {
      expect(
        nodes[index].compareDocumentPosition(nodes[index + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  // #2488 still holds once GitHub entries share the list: they are paged with everything else.
  it("counts GitHub activity toward the timeline page size", async () => {
    const activity = Array.from({ length: 25 }, (_, index) => ({
      kind: "github_activity",
      created_at: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      github_activity: {
        type: "issue_comment",
        github_number: 7,
        github_id: index + 1,
        url: `https://github.com/upstream/proj/pull/7#issuecomment-${index + 1}`,
        author: `commenter-${index + 1}`,
        review_state: null,
      },
    }));
    renderDetail({
      "pulls/get": () => ({ ...pull, commits: [] }),
      "comments/list": () => [],
      "reviews/list": () => [],
      "fixture/pullGithubActivity": () => activity,
    });

    const section = (
      await screen.findByRole("heading", { name: "Comments (0)" })
    ).closest("section")!;
    expect(within(section).getAllByRole("listitem")).toHaveLength(20);
    expect(within(section).queryByText("@commenter-5")).toBeNull();
    expect(within(section).getByText("@commenter-6")).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Load more" }));
    expect(within(section).getAllByRole("listitem")).toHaveLength(25);
    expect(within(section).getByText("@commenter-1")).toBeTruthy();
  });

  it("opens the commit diff dialog for the selected timeline commit", async () => {
    renderDetail({
      "repos/commitDiff": () => ({
        base_sha: "c".repeat(40),
        head_sha: "b".repeat(40),
        files: files.map((file) => ({
          path: file.filename,
          absolute_path: `/tmp/${file.filename}`,
          original_path: file.previousFilename ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
          lines: [],
        })),
      }),
    });

    const section = (
      await screen.findByRole("heading", { name: "Comments (2)" })
    ).closest("section")!;
    const commitButton = within(section).getByRole("button", {
      name: "View timeline changes in bbbbbbb: Earlier change",
    });
    expect(commitButton.tagName).toBe("BUTTON");
    expect(commitButton.hasAttribute("disabled")).toBe(false);
    commitButton.focus();
    fireEvent.click(commitButton);

    await screen.findByRole("dialog", {
      name: "Changes in bbbbbbb: Earlier change",
    });
    expect(await screen.findByText("const x = 1;")).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("dialog", {
        name: "Changes in bbbbbbb: Earlier change",
      }),
      { key: "Escape" },
    );
    expect(screen.queryByRole("dialog", { name: /Changes in bbbbbbb/ })).toBe(
      null,
    );
  });

  it("opens the review details dialog for the selected timeline review", async () => {
    renderDetail();

    const section = (
      await screen.findByRole("heading", { name: "Comments (2)" })
    ).closest("section")!;
    const reviewButton = within(section).getByRole("button", {
      name: "View review for aaaaaaa",
    });
    expect(reviewButton.tagName).toBe("BUTTON");
    expect(reviewButton.hasAttribute("disabled")).toBe(false);
    reviewButton.focus();
    fireEvent.click(reviewButton);

    const dialog = await screen.findByRole("dialog", {
      name: "Reviews for aaaaaaa: Latest change",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show details" }),
    );
    expect(within(dialog).getByText("LGTM")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close reviews" }),
    );
    expect(screen.queryByRole("dialog", { name: /Reviews for/ })).toBe(null);
  });

  it("opens a timeline review without a head SHA using an explicit fallback label", async () => {
    const legacyReview: PullReview = {
      id: 2,
      user: { login: "legacy-bot" },
      author_type: "agent",
      state: "COMMENT",
      body: "Historical review",
      head_sha: null,
      submitted_at: "2026-06-16T10:00:00Z",
      duration_seconds: null,
      ac_results: [],
    };
    renderDetail({ "reviews/list": () => [...reviews, legacyReview] });

    const section = (
      await screen.findByRole("heading", {
        name: "Comments (2)",
      })
    ).closest("section")!;
    const reviewButton = within(section).getByRole("button", {
      name: "View review for Unknown commit",
    });
    expect(reviewButton).toBeTruthy();
    fireEvent.click(reviewButton);

    const dialog = await screen.findByRole("dialog", {
      name: "Reviews for Unknown commit",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show details" }),
    );
    expect(within(dialog).getByText("Historical review")).toBeTruthy();
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
    const react = vi.fn(async (params: { emoji: string }) => {
      serverReactions =
        params.emoji === "🎉"
          ? [
              { emoji: "👍", count: 2, reacted: false },
              { emoji: "🎉", count: 1, reacted: true },
            ]
          : params.emoji === "👍" &&
              serverReactions.some((item) => item.emoji === "🎉")
            ? [{ emoji: "👍", count: 3, reacted: true }]
            : [{ emoji: "👍", count: 2, reacted: false }];
      return { ...comments[0], reactions: serverReactions };
    });
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
    await waitFor(() => expect(listComments).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (screen.queryByLabelText("👍 reaction: 2") as HTMLButtonElement | null)
          ?.disabled,
      ).toBe(false),
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("👍 reaction: 2"));
      await Promise.resolve();
    });
    await waitFor(() => expect(react).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("🎉 reaction: 1")).toBeNull();
    expect(screen.queryByLabelText("👍 reaction: 3")).toBeTruthy();
    await waitFor(() => {
      expect(listComments).toHaveBeenCalledTimes(3);
      expect(
        (screen.queryByLabelText("👍 reaction: 3") as HTMLButtonElement | null)
          ?.disabled,
      ).toBe(false);
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("👍 reaction: 3"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByLabelText("👍 reaction: 2")).toBeTruthy(),
    );
    await waitFor(() => {
      expect(listComments).toHaveBeenCalledTimes(4);
      expect(
        screen.queryByLabelText("👍 reaction: 2")?.getAttribute("aria-pressed"),
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
    await waitFor(() =>
      expect(screen.queryByText("Reaction failed: write failed")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("🎉 reaction: 1")).toBeNull();
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

  it("keeps the answered option checked right after answering an escalation", async () => {
    let answer: string | null = null;
    const escalation = () => ({
      options: ["A", "B"],
      answer,
      answered_at: answer ? "2026-06-18T12:00:00Z" : null,
      superseded: false,
    });
    renderDetail({
      "comments/list": () => [{ ...comments[1], escalation: escalation() }],
      "pullComments/answerEscalation": (params: { option: string }) => {
        answer = params.option;
        return escalation();
      },
    });

    fireEvent.click(await screen.findByRole("radio", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    await screen.findByText("Answered");
    const chosen = screen.getByRole("radio", { name: "B" }) as HTMLInputElement;
    expect(chosen.checked).toBe(true);
    // A disabled radio is greyed until its checked dot is barely visible, so the answer stays enabled.
    expect(chosen.disabled).toBe(false);
    expect(
      (screen.getByRole("radio", { name: "A" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("collapses a superseded escalation and keeps the newest one open", async () => {
    const escalation = {
      options: ["A", "B"],
      answer: null,
      answered_at: null,
    };
    renderDetail({
      "comments/list": () => [
        { ...comments[0], escalation: { ...escalation, superseded: true } },
        { ...comments[1], escalation: { ...escalation, superseded: false } },
      ],
    });

    const summary = await screen.findByLabelText(
      "Superseded escalation PR comment 9",
    );
    expect(summary.textContent).toContain(
      "Superseded escalation · me: Thanks!",
    );
    expect(
      screen.queryByLabelText("Escalation options for PR comment 9"),
    ).toBeNull();
    expect(
      screen.getByLabelText("Escalation options for PR comment 11"),
    ).toBeTruthy();

    fireEvent.click(summary);
    expect(
      screen.getByLabelText("Escalation options for PR comment 9"),
    ).toBeTruthy();
  });

  it("Archive 済み PR comment を Comments 見出しの件数から除外する", async () => {
    const archived = { ...comments[1], archived_at: "2026-06-18T12:00:00Z" };
    renderDetail({ "comments/list": () => [comments[0], archived] });

    expect(
      await screen.findByRole("heading", { name: "Comments (1)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Archived PR comment 11" }),
    ).toBeTruthy();
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
      "PullLeftColumn",
      "PullRightPane",
      "PullPaneRail",
      "PullInfoSection",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  // #59: the left column's sections are in-page anchors, while the sections that moved to the
  // right pane open their view there.
  it("puts the tabs under the PR header, anchoring the left column's sections", async () => {
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
      ["Comments", "#comments"],
    ]);
    for (const [id, component] of [
      ["overview", "PullHeader"],
      ["comments", "PullCommentList"],
    ]) {
      const section = container.querySelector<HTMLElement>(`#${id}`);
      expect(section?.dataset.debugComponent).toBe(component);
      // Anchored sections land below the tab bar as well as the sticky header.
      expect(section?.className).toContain("scroll-mt-11");
    }
  });

  describe("right pane", () => {
    const rail = () =>
      screen.getByRole("navigation", { name: "Right pane views" });
    const railButton = (name: string) =>
      within(rail()).getByRole("button", { name });
    const pane = (container: HTMLElement) =>
      container.querySelector<HTMLElement>(
        '[data-debug-component="PullRightPane"]',
      )!;
    // The file list's row for `filename`; rows live inside the Files changed view.
    const openFileFromList = async (filename = "web/src/a.ts") => {
      if (railButton("Files changed").getAttribute("aria-pressed") !== "true")
        fireEvent.click(railButton("Files changed"));
      fireEvent.click(
        await screen.findByRole("button", {
          name: new RegExp(filename.replace(/[.]/g, "\\.")),
        }),
      );
    };

    it("starts on Files changed and switches views from the rail", async () => {
      renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      expect(railButton("Files changed").getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(railButton("Commits").getAttribute("aria-pressed")).toBe("false");
      expect(
        within(rail())
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label"))
          .filter((label) => label !== "Close right pane"),
      ).toEqual(["Files changed", "Commits", "Evidence"]);

      fireEvent.click(railButton("Evidence"));
      expect(screen.getByRole("heading", { name: "Evidence" })).toBeTruthy();
      expect(
        screen.queryByRole("heading", { name: /Files changed \(/ }),
      ).toBeNull();
      expect(railButton("Files changed").getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(railButton("Evidence").getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(railButton("Commits"));
      expect(screen.getByRole("heading", { name: /Commits \(/ })).toBeTruthy();
      expect(railButton("Commits").getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(railButton("Files changed"));
      expect(
        screen.getByRole("heading", { name: /Files changed \(/ }),
      ).toBeTruthy();
    });

    it("closes from the toggle and reopens on the same view", async () => {
      const { container } = renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      fireEvent.click(railButton("Commits"));

      fireEvent.click(railButton("Close right pane"));
      expect(pane(container).hidden).toBe(true);
      expect(rail()).toBeTruthy();
      expect(
        container.querySelector('[data-debug-component="PullLeftColumn"]')
          ?.className,
      ).toContain("max-w-content");
      expect(
        container.querySelector<HTMLElement>(
          '[data-debug-component="PullDetail"]',
        )?.className,
      ).toContain("justify-center");

      fireEvent.click(railButton("Open right pane"));
      expect(pane(container).hidden).toBe(false);
      expect(screen.getByRole("heading", { name: /Commits \(/ })).toBeTruthy();
    });

    it("moves the boundary by dragging and keeps the left column for as long as the pane is open", async () => {
      const { container } = renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      const root = container.querySelector<HTMLElement>(
        '[data-debug-component="PullDetail"]',
      )!;
      const leftColumn = container.querySelector<HTMLElement>(
        '[data-debug-component="PullLeftColumn"]',
      )!;
      Object.defineProperty(root, "clientWidth", { value: 1400 });
      let measuredWidth = 768;
      Object.defineProperty(leftColumn, "offsetWidth", {
        get: () => measuredWidth,
      });
      const handle = screen.getByRole("separator", {
        name: "Resize right pane",
      });
      handle.setPointerCapture = () => {};
      // The pane takes what the window has left, whatever the left column's width.
      expect(pane(container).className).toContain("flex-[1_0_20rem]");
      expect(leftColumn.style.flexBasis).toBe("");
      expect(leftColumn.className).toContain("flex-[0_1_48rem]");

      fireEvent.pointerDown(handle, { button: 0, clientX: 800 });
      fireEvent.pointerMove(handle, { clientX: 700 });
      fireEvent.pointerUp(handle);
      expect(leftColumn.style.flexBasis).toBe("668px");
      expect(localStorage.getItem("lh_pull_left_column_width")).toBe("668");

      measuredWidth = 668;
      // Past the limit, the pane keeps its minimum.
      fireEvent.pointerDown(handle, { button: 0, clientX: 700 });
      fireEvent.pointerMove(handle, { clientX: 5000 });
      fireEvent.pointerUp(handle);
      expect(leftColumn.style.flexBasis).toBe("1032px");

      fireEvent.click(railButton("Close right pane"));
      expect(leftColumn.style.flexBasis).toBe("");
      localStorage.clear();
    });

    it("keeps one boundary across every view, also after reloading", async () => {
      const { container, unmount } = renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      const leftColumn = () =>
        container.querySelector<HTMLElement>(
          '[data-debug-component="PullLeftColumn"]',
        )!;
      const dragBoundaryBy = (delta: number) => {
        const handle = screen.getByRole("separator", {
          name: "Resize right pane",
        });
        handle.setPointerCapture = () => {};
        fireEvent.pointerDown(handle, { button: 0, clientX: 800 });
        fireEvent.pointerMove(handle, { clientX: 800 + delta });
        fireEvent.pointerUp(handle);
      };
      Object.defineProperty(
        container.querySelector('[data-debug-component="PullDetail"]'),
        "clientWidth",
        { value: 1400 },
      );
      Object.defineProperty(leftColumn(), "offsetWidth", { value: 768 });

      dragBoundaryBy(-100);
      expect(leftColumn().style.flexBasis).toBe("668px");

      await openFileFromList();
      await screen.findByRole("region", { name: "Diff for web/src/a.ts" });
      expect(leftColumn().style.flexBasis).toBe("668px");

      dragBoundaryBy(-200);
      expect(leftColumn().style.flexBasis).toBe("568px");

      fireEvent.click(
        screen.getByRole("button", { name: "Back to file list" }),
      );
      expect(leftColumn().style.flexBasis).toBe("568px");

      fireEvent.click(railButton("Evidence"));
      expect(leftColumn().style.flexBasis).toBe("568px");

      fireEvent.click(railButton("Commits"));
      expect(leftColumn().style.flexBasis).toBe("568px");

      // A drag outside the Files view applies to the Files view too.
      dragBoundaryBy(-100);
      expect(leftColumn().style.flexBasis).toBe("668px");

      fireEvent.click(railButton("Files changed"));
      expect(leftColumn().style.flexBasis).toBe("668px");

      unmount();
      renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      expect(
        document.querySelector<HTMLElement>(
          '[data-debug-component="PullLeftColumn"]',
        )?.style.flexBasis,
      ).toBe("668px");
      localStorage.clear();
    });

    it("closes on the selected icon and opens on the icon pressed while closed", async () => {
      const { container } = renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });

      fireEvent.click(railButton("Files changed"));
      expect(pane(container).hidden).toBe(true);

      fireEvent.click(railButton("Evidence"));
      expect(pane(container).hidden).toBe(false);
      expect(screen.getByRole("heading", { name: "Evidence" })).toBeTruthy();
    });

    it("opens the right pane's view from a section tab without toggling it", async () => {
      const { container } = renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      const tabs = container.querySelector<HTMLElement>(
        '[data-debug-component="PullSectionTabs"]',
      )!;

      fireEvent.click(within(tabs).getByRole("button", { name: "Commits" }));
      expect(pane(container).hidden).toBe(false);

      fireEvent.click(
        within(tabs).getByRole("button", { name: "Files changed" }),
      );
      expect(
        screen.getByRole("heading", { name: /Files changed \(/ }),
      ).toBeTruthy();
    });

    it("offers one rail item for the file list and its diffs", async () => {
      renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });

      expect(railButton("Files changed")).toBeTruthy();
      expect(within(rail()).queryByRole("button", { name: "Diff" })).toBeNull();
    });

    it("opens a file's diff in the same view and returns to the list from the back button", async () => {
      renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });

      await openFileFromList();
      await screen.findByRole("region", { name: "Diff for web/src/a.ts" });
      expect(screen.queryByRole("dialog", { name: /Diff for/ })).toBeNull();
      expect(railButton("Files changed").getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(
        screen.queryByRole("heading", { name: /Files changed \(/ }),
      ).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Back to file list" }),
      );

      expect(
        screen.getByRole("heading", { name: /Files changed \(/ }),
      ).toBeTruthy();
      expect(screen.queryByRole("region", { name: /Diff for/ })).toBeNull();
    });

    it("shows the list from the Files changed tab while a diff is open", async () => {
      const { container } = renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      await openFileFromList();
      await screen.findByRole("region", { name: /Diff for/ });
      const tabs = container.querySelector<HTMLElement>(
        '[data-debug-component="PullSectionTabs"]',
      )!;

      fireEvent.click(
        within(tabs).getByRole("button", { name: "Files changed" }),
      );

      expect(
        screen.getByRole("heading", { name: /Files changed \(/ }),
      ).toBeTruthy();
    });

    it("resumes the open diff when returning from another view", async () => {
      renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      await openFileFromList();
      await screen.findByRole("region", { name: /Diff for/ });

      fireEvent.click(railButton("Evidence"));
      expect(screen.queryByRole("region", { name: /Diff for/ })).toBeNull();

      fireEvent.click(railButton("Files changed"));
      expect(screen.getByRole("region", { name: /Diff for/ })).toBeTruthy();
    });

    it("switches files from the diff's heading", async () => {
      renderDetail({
        "pulls/files": () => [
          files[0],
          { ...files[0], filename: "web/src/b.ts" },
        ],
      });
      await screen.findByRole("heading", { name: /Files changed \(/ });

      await openFileFromList();
      await screen.findByRole("region", { name: "Diff for web/src/a.ts" });

      fireEvent.change(screen.getByRole("combobox", { name: "Diff file" }), {
        target: { value: "web/src/b.ts" },
      });
      await screen.findByRole("region", { name: "Diff for web/src/b.ts" });
    });

    it("keeps the file picked in the dialog when returning to the pane", async () => {
      renderDetail({
        "pulls/files": () => [
          files[0],
          { ...files[0], filename: "web/src/b.ts" },
        ],
      });
      await screen.findByRole("heading", { name: /Files changed \(/ });
      await openFileFromList();
      await screen.findByRole("region", { name: "Diff for web/src/a.ts" });

      fireEvent.click(
        screen.getByRole("button", { name: "Show diff full screen" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "web/src/b.ts" }));
      await screen.findByRole("dialog", { name: "Diff for web/src/b.ts" });
      fireEvent.keyDown(document, { key: "Escape" });

      await screen.findByRole("region", { name: "Diff for web/src/b.ts" });
    });

    it("gives the window's extra width to the pane in the Diff view too, and only while open", async () => {
      const { container } = renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      const leftColumn = container.querySelector<HTMLElement>(
        '[data-debug-component="PullLeftColumn"]',
      )!;
      const fixedLeftColumn = "flex-[0_1_48rem]";
      expect(leftColumn.className).toContain(fixedLeftColumn);

      await openFileFromList();
      expect(leftColumn.className).toContain(fixedLeftColumn);
      expect(pane(container).className).toContain("flex-[1_0_20rem]");

      fireEvent.click(railButton("Close right pane"));
      expect(leftColumn.className).not.toContain(fixedLeftColumn);
      expect(leftColumn.className).toContain("flex-1");
    });

    it("leaves a pane closed when Viewed settles after it was closed", async () => {
      let settleViewed!: (views: unknown[]) => void;
      const { container } = renderDetail({
        "pulls/files": () => [
          files[0],
          { ...files[0], filename: "web/src/b.ts" },
        ],
        "pullFileViews/set": () =>
          new Promise((resolve) => {
            settleViewed = resolve;
          }),
      });
      await screen.findByRole("heading", { name: /Files changed \(/ });
      await openFileFromList();
      await screen.findByRole("region", { name: "Diff for web/src/a.ts" });

      fireEvent.click(screen.getByRole("checkbox", { name: "Viewed" }));
      await waitFor(() => expect(settleViewed).toBeTruthy());
      fireEvent.click(railButton("Close right pane"));
      await act(async () => settleViewed([]));

      expect(pane(container).hidden).toBe(true);
      expect(railButton("Open right pane")).toBeTruthy();
    });

    it("expands the diff into the dialog and returns to the pane on Escape", async () => {
      renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      await openFileFromList();
      await screen.findByRole("region", { name: /Diff for/ });
      expect(
        screen.queryByRole("complementary", { name: "Changed files" }),
      ).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Show diff full screen" }),
      );
      expect(
        screen.getByRole("dialog", { name: /Diff for/ }).parentElement
          ?.className,
      ).toContain("backdrop-blur-sm");
      expect(
        screen.getByRole("complementary", { name: "Changed files" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Back to file list" })).toBe(
        null,
      );

      fireEvent.keyDown(document, { key: "Escape" });
      await screen.findByRole("region", { name: /Diff for/ });
      expect(screen.queryByRole("dialog", { name: /Diff for/ })).toBeNull();
    });

    it("returns to the pane from the dialog's close button and backdrop", async () => {
      renderDetail();
      await screen.findByRole("heading", { name: /Files changed \(/ });
      await openFileFromList();
      await screen.findByRole("region", { name: /Diff for/ });
      const expand = () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Show diff full screen" }),
        );

      expand();
      fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
      await screen.findByRole("region", { name: /Diff for/ });

      expand();
      const backdrop = screen.getByRole("dialog", { name: /Diff for/ })
        .parentElement as HTMLElement;
      fireEvent.click(backdrop);
      await screen.findByRole("region", { name: /Diff for/ });
      expect(screen.queryByRole("dialog", { name: /Diff for/ })).toBeNull();
    });

    it("keeps a half-written diff comment when moving between pane and dialog", async () => {
      renderDetail({
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: files[0].filename,
              original_path: null,
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+const x = 1;",
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -0,0 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+const x = 1;",
                  left_line: null,
                  right_line: 1,
                },
              ],
            },
          ],
        }),
      });
      await screen.findByRole("heading", { name: /Files changed \(/ });
      await openFileFromList();
      const view = await screen.findByRole("region", { name: /Diff for/ });
      fireEvent.click(
        await within(view).findByRole("button", {
          name: "Comment on new line 1",
        }),
      );
      fireEvent.change(await within(view).findByRole("textbox"), {
        target: { value: "draft" },
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Show diff full screen" }),
      );

      const expanded = screen.getByRole("dialog", { name: /Diff for/ });
      expect(
        (within(expanded).getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("draft");

      fireEvent.keyDown(document, { key: "Escape" });
      const pane = await screen.findByRole("region", { name: /Diff for/ });
      expect(
        (within(pane).getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("draft");
    });
  });

  // #2089: the sticky header is the left column's own first child, so its sticky box — and with it
  // the bar's width — follows the left column instead of spanning the pane too.
  it("anchors the sticky header to the main column, not the full page width", async () => {
    const { container } = renderDetail();

    await screen.findByText("ui2: PR detail");
    const mainContent = container.querySelector<HTMLElement>(
      '[data-debug-component="PullMainContent"]',
    );
    const pane = container.querySelector<HTMLElement>(
      '[data-debug-component="PullRightPane"]',
    );
    expect(mainContent?.firstElementChild?.className).toContain("sticky");
    expect(pane).not.toBeNull();
    expect(mainContent?.contains(pane as Node)).toBe(false);
  });

  // #59: the header above the section tabs is the title and its status only — the worktree and the
  // branch pair live in the band above the Evidence, so they read once per page.
  it("keeps the header to the title and status, with the basics only in the band above the Evidence", async () => {
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

  // #1908: the base branch stays copyable, symmetrically with the head branch.
  it("copies the base branch with visible feedback", async () => {
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

  // The worktree and base ← head branch pair sit in their own band in the left column, with the
  // home directory shortened to `~` and no Opened / Linked issue rows.
  it("shows the worktree and branch band with copy actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const worktreePath = "/Users/me/.loophub/worktrees/me/proj/pr-30";
    const { container } = renderDetail({
      "pulls/get": () => ({ ...pull, worktree_path: worktreePath }),
    });

    await screen.findByText("Evidence");
    const block = container.querySelector<HTMLElement>(
      '[data-debug-component="PullInfoSection"]',
    )!;
    expect(within(block).getByText("Worktree")).toBeTruthy();
    expect(within(block).getByText("Branch")).toBeTruthy();
    const shown = within(block).getByText("~/.loophub/worktrees/me/proj/pr-30");
    expect(shown.getAttribute("title")).toBe(worktreePath);
    expect(within(block).queryByText("Opened")).toBeNull();
    expect(within(block).queryByText("Linked issue")).toBeNull();
    expect(within(block).queryByText("@impl-bot")).toBeNull();
    // base on the left: main ← issue-153
    const codes = [...block.querySelectorAll("code")].map((c) => c.textContent);
    expect(codes.slice(1)).toEqual(["main", "issue-153"]);
    expect(within(block).getByText("←")).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        within(block).getByRole("button", { name: "Copy worktree path" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith(worktreePath);

    await act(async () => {
      fireEvent.click(
        within(block).getByRole("button", { name: "Copy head branch" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith("issue-153");
  });

  it("shows an unavailable worktree without an empty copy action, keeping the branch pair", async () => {
    const { container } = renderDetail();

    await screen.findByText("Evidence");
    const block = container.querySelector<HTMLElement>(
      '[data-debug-component="PullInfoSection"]',
    )!;
    expect(within(block).getByText("Unavailable")).toBeTruthy();
    expect(
      within(block).queryByRole("button", { name: "Copy worktree path" }),
    ).toBeNull();
    expect(within(block).getByText("issue-153")).toBeTruthy();
    expect(within(block).getByText("main")).toBeTruthy();
  });

  it("has neither a PR details section nor the old sidebar", async () => {
    const { container } = renderDetail();

    await screen.findByText("ui2: PR detail");
    expect(screen.queryByRole("heading", { name: "PR details" })).toBeNull();
    expect(
      container.querySelector('[data-debug-component="PullSidebar"]'),
    ).toBeNull();
  });

  it("does not render an independent Work duration section", async () => {
    renderDetail();

    await screen.findByText("ui2: PR detail");
    expect(screen.queryByRole("heading", { name: "Work duration" })).toBeNull();
  });

  it("does not render an independent Reviews section", async () => {
    renderDetail();

    await findFilesChangedHeading(/Files changed \(1\)/);
    expect(screen.getByLabelText("File status: modified")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Reviews" })).toBeNull();
  });

  it("shows each changed file as status, trailing filename, and changes on one row", async () => {
    renderDetail();

    await findFilesChangedHeading(/Files changed \(1\)/);
    const filename = screen.getByText("web/src/a.ts");
    const row = filename.closest("button")!;
    expect(Array.from(row.children).map((child) => child.textContent)).toEqual([
      "M",
      "web/src/a.ts",
      "+1−1",
      "",
      "",
    ]);
    expect(row.className).toContain("grid-cols-");
    expect(filename.className).toContain("truncate");
    expect(filename.className).toContain("font-mono");
    expect(filename.className).toContain("text-xs");
    expect(filename.className).toContain("[direction:rtl]");
  });

  // The Commits section's own behaviour is covered by pull-commits-section.test.tsx; the PR detail
  // only has to show it, with this PR's commits, in the right pane.
  it("shows the PR's commits in the right pane", async () => {
    renderDetail();
    await openCommitsView();

    const commitsHeading = await screen.findByRole("heading", {
      name: "Commits (2)",
    });

    expect(
      commitsHeading.closest('[data-debug-component="PullRightPane"]'),
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

    await openCommitsView();
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
    fireEvent.click(
      within(currentDialog).getByRole("button", { name: "Show details" }),
    );
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

    await openCommitsView();
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

    await openCommitsView();
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

    await openCommitsView();
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

  it("shows the Workflow summary under the PR badges with Detail access", async () => {
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

    const summary = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-debug-component="WorkflowRunSummary"]',
      );
      expect(element).toBeTruthy();
      return element!;
    });
    expect(summary.closest('[data-debug-component="PullHeader"]')).toBeTruthy();
    expect(summary.closest("aside")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Workflow" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    // Name, run number and rework count moved into the detail dialog.
    expect(screen.queryByText("Implementation loop")).toBeNull();
    expect(screen.queryByText("Rework: 2/8")).toBeNull();
    expect(within(summary).getByText("Verify")).toBeTruthy();
    expect(within(summary).getByText("Total cost")).toBeTruthy();
    // The total is a second request, started only once the run is known, so it can still be in
    // flight when the run itself renders — wait for it rather than for whatever render happens
    // to land first.
    expect(await screen.findByText("$1.75")).toBeTruthy();
    expect(within(summary).getByText("needs human")).toBeTruthy();
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

  it("shows the needs human marker after increasing the budget", async () => {
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

    expect(await screen.findByText("needs human")).toBeTruthy();
    expect(screen.queryByText("waiting for a decision")).toBeNull();
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

    await screen.findByRole("button", { name: "Detail" });
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
        pr_merged: false,
        merge_ready: true,
        merge_conflict: false,
      }),
    });

    await screen.findByRole("button", { name: "Detail" });
    expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
    expect(screen.getByText("Verify")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detail" })).toBeTruthy();
    expect(screen.queryByText(/continuing/i)).toBeNull();
  });

  it("hides Workflow run when none is linked", async () => {
    renderDetail({ "workflowRuns/stateForPull": () => null });
    await screen.findByText("ui2: PR detail");
    await waitFor(() =>
      expect(rpcCall("workflowRuns/stateForPull")).toBeTruthy(),
    );
    expect(
      document.querySelector('[data-debug-component="WorkflowRunSummary"]'),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Detail" })).toBeNull();
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

  describe("sticky header second row", () => {
    // Reports every observed element as out of view, so the title has scrolled past from the start.
    beforeEach(() => {
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          callback: IntersectionObserverCallback;
          constructor(callback: IntersectionObserverCallback) {
            this.callback = callback;
          }
          observe(target: Element) {
            this.callback(
              [{ target, isIntersecting: false } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
          }
          unobserve() {}
          disconnect() {}
          takeRecords() {
            return [];
          }
        },
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const stickyBar = () =>
      document.querySelector<HTMLElement>(
        '[data-debug-component="DetailStickyHeader"]',
      );
    const leftColumn = () =>
      document.querySelector<HTMLElement>(
        '[data-debug-component="PullLeftColumn"]',
      );
    const tabs = () =>
      document.querySelector<HTMLElement>(
        '[data-debug-component="PullSectionTabs"]',
      );

    function expectOneRow() {
      expect(stickyBar()?.children).toHaveLength(1);
      expect(
        stickyBar()?.querySelector(
          '[data-debug-component="WorkflowRunSummary"]',
        ),
      ).toBeNull();
      expect(leftColumn()?.className.split(/\s+/)).toContain("scroll-pt-11");
      expect(tabs()?.className.split(/\s+/)).toContain("top-5");
    }

    it("puts the Workflow progress on its own row and drops the tabs below it", async () => {
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
        }),
      });

      await waitFor(() => expect(stickyBar()?.children).toHaveLength(2));
      const [identity, progress] = Array.from(stickyBar()?.children ?? []);
      expect(identity.textContent).toContain("ui2: PR detail");
      expect(
        identity.querySelector('[data-debug-component="WorkflowRunSummary"]'),
      ).toBeNull();
      expect(
        progress.querySelector('[data-debug-component="WorkflowRunSummary"]'),
      ).toBeTruthy();
      expect(leftColumn()?.className.split(/\s+/)).toContain("scroll-pt-16");
      expect(tabs()?.className.split(/\s+/)).toContain("top-10");
    });

    it("stays one row while the run is loading", async () => {
      renderDetail({
        "workflowRuns/stateForPull": () => new Promise(() => {}),
      });
      await screen.findByText("Loading Workflow run…");
      expectOneRow();
    });

    it("stays one row when the PR has no run", async () => {
      renderDetail({ "workflowRuns/stateForPull": () => null });
      await screen.findAllByText("ui2: PR detail");
      await waitFor(() =>
        expect(rpcCall("workflowRuns/stateForPull")).toBeTruthy(),
      );
      expectOneRow();
    });

    it("stays one row when the run fails to load", async () => {
      renderDetail({
        "workflowRuns/stateForPull": () => {
          throw new RpcFault(500, "workflow state unavailable");
        },
      });
      await screen.findByText("Failed to load Workflow run.");
      expectOneRow();
    });
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
        unpushed_commits: 0,
        unpulled_commits: 0,
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

// The GitHub PR view lives in the right pane, behind its rail icon.
async function openGithubPrView() {
  const rail = await screen.findByRole("navigation", {
    name: "Right pane views",
  });
  fireEvent.click(
    await within(rail).findByRole("button", { name: "GitHub PR" }),
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

  it("drops the Create action once exported and links to GitHub from the GitHub PR view (#2035)", async () => {
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: linkedGithubPull(null),
    });
    await openGithubPrView();
    // The only route to the GitHub PR is the link in the GitHub PR view's body (#2091) —
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
    await openGithubPrView();
    // github_pull present means the export landed: the GitHub PR view offers the push (#2516) and
    // the action row has no in-progress Create button left over.
    await screen.findByRole("button", { name: /Push to GitHub/i });
    expect(screen.queryByRole("button", { name: /Creating…/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Create PR on GitHub/i }),
    ).toBeNull();
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
    await openGithubPrView();
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
    vi.setSystemTime(new Date("2026-06-18T14:00:00Z"));
    const expiresIn = 1_000;
    renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: null,
      github_pr_export_started_at: new Date(
        Date.now() - GITHUB_PR_EXPORT_PENDING_TTL_MS + expiresIn,
      ).toISOString(),
    });
    await screen.findByRole("button", { name: /Creating…/i });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(expiresIn + 1);
    });

    const button = (await screen.findByRole("button", {
      name: /Create PR on GitHub/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
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

  describe("GitHub PR view", () => {
    const railButton = (name: string) =>
      within(
        screen.getByRole("navigation", { name: "Right pane views" }),
      ).getByRole("button", { name });
    const githubIcon = () => railButton("GitHub PR");
    const statusDot = () =>
      githubIcon().querySelector<HTMLElement>('[aria-hidden="true"].absolute');
    const pendingStatus = () => new Promise(() => {});
    const failedStatus = () => {
      throw new Error("GitHub is down");
    };

    it("moves the section out of the left column into the right pane", async () => {
      const { container } = renderDetailWithPull({
        github_pull: linkedGithubPull(null),
      });
      await screen.findByText("ui2: PR detail");
      await screen.findByRole("button", { name: "GitHub PR" });
      expect(screen.queryByRole("heading", { name: "GitHub PR" })).toBeNull();
      expect(
        container
          .querySelector('[data-debug-component="GithubPrStatusSection"]')
          ?.closest('[data-debug-component="PullRightPane"]'),
      ).not.toBeNull();

      await openGithubPrView();
      await screen.findByRole("heading", { name: "GitHub PR" });
      expect(githubIcon().getAttribute("aria-pressed")).toBe("true");
      expect(railButton("Commits").getAttribute("aria-pressed")).toBe("false");
    });

    it("closes the pane from the selected icon, like the other views", async () => {
      const { container } = renderDetailWithPull({
        github_pull: linkedGithubPull(null),
      });
      await openGithubPrView();
      fireEvent.click(githubIcon());
      expect(
        container.querySelector<HTMLElement>(
          '[data-debug-component="PullRightPane"]',
        )?.hidden,
      ).toBe(true);
      expect(githubIcon().getAttribute("aria-pressed")).toBe("false");
    });

    it("has no icon or view without a linked GitHub PR", async () => {
      const { container } = renderDetailWithPull({ github_pull: null });
      await screen.findByText("ui2: PR detail");
      expect(
        within(
          screen.getByRole("navigation", { name: "Right pane views" }),
        ).queryByRole("button", { name: "GitHub PR" }),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-debug-component="GithubPrStatusSection"]',
        ),
      ).toBeNull();
    });

    it("marks a loaded status on the icon", async () => {
      renderDetailWithPull({ github_pull: linkedGithubPull(null) });
      await screen.findByRole("button", { name: "GitHub PR" });
      await waitFor(() => expect(githubIcon().title).toBe("GitHub PR: Loaded"));
      expect(statusDot()?.className).toContain("bg-green-500");
    });

    it.each([
      ["Loading", pendingStatus, "bg-muted-foreground"],
      ["Failed", failedStatus, "bg-destructive"],
    ])("marks a %s status on the icon and keeps the view's actions usable", async (label, handler, dotClass) => {
      renderDetailWithPull(
        { github_pull: linkedGithubPull("previous-head") },
        { "pulls/githubStatus": handler },
      );
      await screen.findByRole("button", { name: "GitHub PR" });
      await waitFor(() =>
        expect(githubIcon().title).toBe(`GitHub PR: ${label}`),
      );
      expect(statusDot()?.className).toContain(dotClass);

      await openGithubPrView();
      expect(
        screen
          .getByRole("link", { name: "me/proj/pull/7" })
          .getAttribute("href"),
      ).toBe("https://github.com/me/proj/pull/7");
      expect(
        screen
          .getByRole("button", { name: /Push to GitHub/i })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(
        screen
          .getByRole("button", { name: /Unlink GitHub PR/i })
          .hasAttribute("disabled"),
      ).toBe(false);
    });

    it("returns to Commits when the open view's GitHub PR is unlinked", async () => {
      let override: Partial<PullRequest> = {
        github_pull: linkedGithubPull(null),
      };
      renderDetailWithPull(() => override, {
        "pulls/unlinkGithubPull": () => {
          override = { github_pull: null };
          return { unlinked: true, github_number: 7 };
        },
      });
      await openGithubPrView();
      fireEvent.click(
        await screen.findByRole("button", { name: /Unlink GitHub PR/i }),
      );
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: /^Unlink$/ }));

      await waitFor(() =>
        expect(railButton("Commits").getAttribute("aria-pressed")).toBe("true"),
      );
      await screen.findByRole("heading", { name: /Commits \(/ });
      expect(
        within(
          screen.getByRole("navigation", { name: "Right pane views" }),
        ).queryByRole("button", { name: "GitHub PR" }),
      ).toBeNull();
    });
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

  // #2516: pushing acts on the linked GitHub PR, so the controls live with that link in the GitHub
  // PR view — the action row keeps only the LoopHub-side write actions. The push behaviour itself is
  // covered in github-pr-status.test.tsx.
  it("renders the push controls in the GitHub PR view, not the action row (#2516)", async () => {
    const { container } = renderDetailWithPull({
      merge_mode: "github_pr",
      github_pull: linkedGithubPull("previous-head"),
    });

    await openGithubPrView();
    const push = await screen.findByRole("button", { name: /Push to GitHub/i });
    expect(
      push.closest('[data-debug-component="GithubPrStatusSection"]'),
    ).toBeTruthy();

    const body = container.querySelector(
      '[data-debug-component="PullBody"]',
    ) as HTMLElement;
    expect(
      within(body).queryByRole("button", { name: /Push to GitHub/i }),
    ).toBeNull();
    expect(
      within(body).queryByRole("button", { name: /Push options/i }),
    ).toBeNull();
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
    expect(scrollIntoView.mock.contexts[0]).toBe(section);
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

// #2640: the linked issue's body and per-criterion status take the PR's own place; its Evidence
// lives in the right pane.
describe("PullDetail — linked issue description (#2640)", () => {
  const criteria = [1, 2, 3].map((n) => ({
    id: `153-${n}`,
    number: n,
    ordinal: n,
    text: `Criterion ${n}`,
  }));
  const linkedIssue = {
    number: 153,
    title: "ui2: PR list + detail + merged",
    body: "The issue spec body.",
    acceptance_criteria: criteria,
  };
  function gradedReview(
    id: number,
    submittedAt: string,
    verdicts: Record<number, "pass" | "fail">,
  ): PullReview {
    return {
      ...reviews[0],
      id,
      head_sha: "old-head",
      submitted_at: submittedAt,
      ac_results: Object.entries(verdicts).map(([n, verdict]) => ({
        criterion_id: `153-${n}`,
        number: Number(n),
        text: `Criterion ${n}`,
        verdict,
        note: "",
      })),
    };
  }
  function verdictOf(text: string) {
    const item = screen.getByText(text).closest("li") as HTMLElement;
    return item.querySelector("svg")?.getAttribute("aria-label");
  }
  const evidence = () =>
    document.querySelector<HTMLElement>(
      '[data-debug-component="PullEvidence"]',
    )!;

  it("shows the issue body and grades from the latest grading review, whatever head it read", async () => {
    renderDetail({
      "issues/get": () => linkedIssue,
      "reviews/list": () => [
        gradedReview(10, "2026-06-18T10:00:00Z", { 1: "fail", 2: "fail" }),
        gradedReview(11, "2026-06-18T10:30:00Z", { 1: "pass", 2: "fail" }),
        // A later review with no grading does not reset the criteria.
        { ...reviews[0], id: 12, submitted_at: "2026-06-18T11:00:00Z" },
      ],
    });

    await screen.findByText("The issue spec body.");
    const issueLink = screen
      .getAllByRole("link", { name: "#153" })
      .find((link) =>
        link.closest('[data-debug-component="PullLinkedIssueDescription"]'),
      );
    expect(issueLink?.getAttribute("href")).toBe("/r/me/proj/issues/153");
    expect(verdictOf("Criterion 1")).toBe("Met");
    expect(verdictOf("Criterion 2")).toBe("Not met");
    expect(verdictOf("Criterion 3")).toBe("Not graded");
    expect(screen.getByText(/1\/3 met · 1 not met · 1 not/)).toBeTruthy();

    expect(
      within(evidence()).getByText("Render diff, reviews, comments."),
    ).toBeTruthy();
  });

  it("marks every criterion Not graded when no review graded criteria", async () => {
    renderDetail({ "issues/get": () => linkedIssue });

    await screen.findByText("The issue spec body.");
    for (const criterion of criteria) {
      expect(verdictOf(criterion.text)).toBe("Not graded");
    }
    expect(screen.getByText(/0\/3 met · 0 not met · 3 not/)).toBeTruthy();
  });

  it("keeps the Evidence in the right pane when the linked issue has no structured criteria", async () => {
    renderDetail({
      "issues/get": () => ({ ...linkedIssue, acceptance_criteria: undefined }),
    });

    await screen.findByText("Render diff, reviews, comments.");
    expect(screen.queryByText("The issue spec body.")).toBeNull();
    expect(
      within(evidence()).getByText("Render diff, reviews, comments."),
    ).toBeTruthy();
    expect(
      evidence().closest('[data-debug-component="PullRightPane"]'),
    ).toBeTruthy();
  });

  it("keeps the worktree and branch band directly below the criteria", async () => {
    const { container } = renderDetail({ "issues/get": () => linkedIssue });

    await screen.findByText("The issue spec body.");
    const band = container.querySelector<HTMLElement>(
      '[data-debug-component="PullInfoSection"]',
    )!;
    expect(band.previousElementSibling).toBe(
      screen.getByText("Acceptance criteria").closest("section"),
    );
  });

  it("shows the Evidence read-only", async () => {
    renderDetail();

    const rail = await screen.findByRole("navigation", {
      name: "Right pane views",
    });
    fireEvent.click(within(rail).getByRole("button", { name: "Evidence" }));

    expect(
      within(evidence()).getByText("Render diff, reviews, comments."),
    ).toBeTruthy();
    expect(within(evidence()).queryByRole("button")).toBeNull();
    expect(within(evidence()).queryByRole("textbox")).toBeNull();
  });

  it("says so when the PR has no Evidence", async () => {
    renderDetailWithPull({ body: "" });

    const rail = await screen.findByRole("navigation", {
      name: "Right pane views",
    });
    fireEvent.click(within(rail).getByRole("button", { name: "Evidence" }));

    expect(within(evidence()).getByText("No evidence.")).toBeTruthy();
  });
});

describe("PullDetail — comment permalinks", () => {
  it("reads the comment id from a permalink fragment", () => {
    expect(commentIdFromHash("comment-11")).toBe(11);
    expect(commentIdFromHash("comments")).toBeNull();
    expect(commentIdFromHash("comment-x")).toBeNull();
  });

  it("scrolls to and highlights the comment a permalink names", async () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    renderDetail({}, ["/#comment-11"]);

    await screen.findByText("Rebased on main.");
    const target = document.getElementById("comment-11");
    expect(target?.dataset.highlighted).toBe("true");
    expect(document.getElementById("comment-9")?.dataset.highlighted).toBe(
      undefined,
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
  });

  it("copies a PR comment's permalink from its three dots menu", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderDetail({
      "comments/list": () => [
        { ...comments[0], html_url: "/r/me/proj/pulls/30#comment-9" },
      ],
    });

    fireEvent.pointerDown(
      await screen.findByLabelText("Actions for PR comment 9"),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/r/me/proj/pulls/30#comment-9`,
      ),
    );
  });
});
