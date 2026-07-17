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
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import type { Issue, IssueComment } from "@/api/types";
import { ACTION_LOADING_MS } from "@/lib/use-fixed-loading";
import { HOVER_POPUP_DELAY_MS } from "@/lib/use-hover-popover";
import { WebConfigProvider } from "@/lib/web-config";

// The Build button launches through the terminal backend abstraction; capture the call.
const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));

import { IssueDetail } from "./issue-detail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  launchTerminal.mockClear();
});

// The linked-PR popover now opens after a standard hover delay, so hover the row
// and advance fake timers past the delay before asserting the popover contents.
function openLinkedPullPopover(label: string) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.mouseEnter(screen.getByLabelText(label));
  act(() => {
    vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
  });
}

const issue: Issue = {
  number: 12,
  state: "open",
  title: "ui2: issue detail",
  body: "Render title, body, labels.",
  target_branch: null,
  user: { login: "me" },
  labels: [{ name: "ready-to-build", color: null }],
  comments: 1,
  created_at: "2026-06-17T11:00:00Z",
  updated_at: "2026-06-17T12:00:00Z",
  linked_pull_request: {
    number: 30,
    title: "ui2: issue detail PR",
    state: "open",
    merged: false,
    html_url: "/pulls/30",
    github_pull: null,
    cost_stopped: false,
  },
};

const comments: IssueComment[] = [
  {
    id: 1,
    user: { login: "design-bot" },
    body: "Looks good.",
    created_at: "2026-06-17T11:30:00Z",
  },
];

function mockFetch(
  getIssue: () => Issue = () => issue,
  autoModeOnBuild = false,
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  return mockRpcFetch({
    ...extraHandlers,
    "issues/get": getIssue,
    "comments/list": () => comments,
    "comments/create": (p) => ({
      id: 2,
      user: { login: "me" },
      body: p.body,
      created_at: "2026-06-17T12:30:00Z",
    }),
    "settings/get": () => ({
      agents: {
        "claude-code": { autoModeOnBuild, model: "opus", effort: "medium" },
        codex: {
          autoModeOnBuild: false,
          model: "gpt-5.5",
          effort: "medium",
        },
      },
      codingAgent: "claude-code",
    }),
  });
}

function renderDetail(
  getIssue?: () => Issue,
  autoModeOnBuild = false,
  extraHandlers: Record<string, (params: any) => unknown> = {},
  legacy = true,
) {
  vi.stubGlobal("fetch", mockFetch(getIssue, autoModeOnBuild, extraHandlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <WebConfigProvider config={{ experimental: false, legacy }}>
        <IssueDetail owner="me" repo="proj" number={12} />
      </WebConfigProvider>
    ),
  });
  // The linked-PR link targets the pulls route; register it for the router.
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
  const issueListRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      pullsRoute,
      issuesRoute,
      issueListRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...rendered, router };
}

describe("IssueDetail", () => {
  it("renders title, body, labels, comments, and the linked PR summary", async () => {
    renderDetail();

    expect(await screen.findByText("ui2: issue detail")).toBeTruthy();
    expect(screen.getByText("Render title, body, labels.")).toBeTruthy();
    expect(screen.getByText("ready-to-build")).toBeTruthy();
    expect(screen.queryByText(/^branch:/)).toBeNull();
    expect(screen.getByText("Looks good.")).toBeTruthy();

    const prLink = screen.getByRole("link", { name: "PR #30" });
    expect(prLink.getAttribute("href")).toBe("/r/me/proj/pulls/30");
    expect(
      screen.getByLabelText("Linked PR #30: ui2: issue detail PR"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "ui2: issue detail PR" }),
    ).toBeNull();
    expect(prLink.closest("div")?.textContent).toContain("open");
  });

  it("renders the target branch chip when the issue has a target branch", async () => {
    renderDetail(() => ({
      ...issue,
      target_branch: "feature/foo-bar",
    }));

    const chip = await screen.findByText("branch:feature/foo-bar");

    expect(chip).toBeTruthy();
    expect(chip.getAttribute("title")).toBe("Target branch: feature/foo-bar");
  });

  it("keeps bottom spacing after the comments section", async () => {
    renderDetail();

    const textarea = await screen.findByLabelText("Add a comment");
    const commentsSection = textarea.closest("section");

    expect(commentsSection?.className).toContain("pb-6");
    expect(commentsSection?.textContent).toContain("Looks good.");
  });

  it("returns to the issue list with u unless a modal dialog is open", async () => {
    const { router } = renderDetail();

    expect(await screen.findByText("ui2: issue detail")).toBeTruthy();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    fireEvent.keyDown(window, { key: "u" });
    expect(router.state.location.pathname).toBe("/");

    dialog.remove();
    fireEvent.keyDown(window, { key: "u" });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/me/proj/issues"),
    );
  });

  it("omits working from a linked PR row while Herdr is working", async () => {
    renderDetail(
      () => ({
        ...issue,
        linked_pull_request: {
          ...issue.linked_pull_request!,
          review_state: "CHANGES_REQUESTED",
        },
      }),
      false,
      {
        "terminal/sessions": () => ({
          repos: [
            {
              repo: "me/proj",
              session_name: "lh-me-proj",
              agents: [{ id: "%7", name: "dev #12", status: "working" }],
              pull_workspaces: [{ pull: 30, pane_id: "%7", status: "working" }],
            },
          ],
        }),
      },
    );

    const summary = await screen.findByText("PR #30");
    const statusCell = summary.closest("div");
    const ctx = within(statusCell as HTMLElement);
    expect(ctx.queryByText("working")).toBeNull();
    expect(ctx.getByText("open")).toBeTruthy();
    const bot = statusCell?.querySelector("svg");
    expect(bot?.parentElement?.className).toContain("dark:bg-sky-950");
    expect(bot?.parentElement?.className).toContain("dark:text-sky-300");
  });

  // #863: a cost-stopped PR shows an "over budget" badge on the issue-detail linked-PR row.
  it("shows a cost-stopped badge on the linked-PR row when the PR was stopped", async () => {
    renderDetail(() => ({
      ...issue,
      linked_pull_request: {
        ...issue.linked_pull_request!,
        cost_stopped: true,
        total_tokens: 1000,
        cost_usd: 10.01,
      },
    }));

    const badge = await screen.findByTitle(
      "Stopped — agent cost limit exceeded",
    );
    expect(badge.textContent).toContain("over budget");
    const row = screen.getByLabelText("Linked PR #30: ui2: issue detail PR");
    const cost = row.querySelector<HTMLElement>("[data-linked-pull-cost]");
    expect(cost?.textContent).toBe("$10");
    expect(cost?.className).toContain("text-amber-700");
    expect(cost?.className).toContain("dark:text-amber-300");
  });

  it("keeps the linked-PR cost muted when it was never stopped", async () => {
    renderDetail(() => ({
      ...issue,
      linked_pull_request: {
        ...issue.linked_pull_request!,
        cost_stopped: false,
        total_tokens: 1000,
        cost_usd: 30.01,
      },
    }));
    const row = await screen.findByLabelText(
      "Linked PR #30: ui2: issue detail PR",
    );
    expect(screen.queryByText("over budget")).toBeNull();
    const cost = row.querySelector<HTMLElement>("[data-linked-pull-cost]");
    expect(cost?.textContent).toBe("$30");
    expect(cost?.className).toContain("text-muted-foreground/70");
    expect(cost?.className).not.toContain("text-amber");
  });

  it("hides the linked-PR summary when no PR is linked", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    await screen.findByText("ui2: issue detail");
    expect(screen.queryByText(/^PR #/)).toBeNull();
  });

  it("shows the New Issue Herdr pane in the Agents section and focuses it", async () => {
    renderDetail(
      () => ({
        ...issue,
        herdr_pane: {
          launch_id: "launch-1",
          pane_id: "w4:p2",
          session_name: "me-proj-12345678",
        },
      }),
      false,
      {
        "terminal/focusAgent": () => ({ ok: true }),
      },
    );

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByText("me-proj-12345678")).toBeTruthy();
    expect(screen.getByText("New Issue pane")).toBeTruthy();

    const button = screen.getByRole("button", { name: "Open in Herdr" });
    fireEvent.click(button);
    await waitFor(() => {
      expect(rpcCall("terminal/focusAgent")?.params).toEqual({
        repo: "me/proj",
        paneId: "w4:p2",
      });
    });
  });

  it("hides the Agents section when no New Issue Herdr pane is linked", async () => {
    renderDetail(() => ({ ...issue, herdr_pane: null }));

    await screen.findByText("ui2: issue detail");
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in Herdr" })).toBeNull();
  });

  it("does not aggregate linked-PR worktree agents into issue Agents", async () => {
    renderDetail(() => ({ ...issue, herdr_pane: null }), false, {
      "terminal/sessions": () => ({
        repos: [
          {
            repo: "me/proj",
            session_name: "lh-me-proj",
            agents: [{ id: "%7", name: "dev #12", status: "working" }],
            issue_workspaces: [{ issue: 12, pane_id: "%7", status: "working" }],
            pull_workspaces: [{ pull: 30, pane_id: "%7", status: "working" }],
          },
        ],
      }),
    });

    expect(await screen.findByText("PR #30")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in Herdr" })).toBeNull();
    openLinkedPullPopover("Linked PR #30: ui2: issue detail PR");
    expect(screen.getByRole("button", { name: "Open in Herdr" })).toBeTruthy();
  });

  it("does not render the issue Sessions section", async () => {
    renderDetail(() => ({
      ...issue,
      related_sessions: [
        {
          id: "session-1",
          agent: "lh-issue-create",
          session: "session-1",
          created_at: "2026-06-17T10:00:00Z",
          updated_at: "2026-06-17T10:00:00Z",
          kind: "issue-create",
          linked_at: "2026-06-17T11:00:00Z",
          resume: { resumable: true },
        },
      ],
    }));

    await screen.findByText("ui2: issue detail");
    expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
    expect(screen.queryByText("lh-issue-create")).toBeNull();
  });

  it("renders every linked PR from the detail response array", async () => {
    const multiPr: Issue = {
      ...issue,
      linked_pull_request: {
        number: 31,
        title: "current attempt",
        state: "open",
        merged: false,
        html_url: "/pulls/31",
        github_pull: null,
        cost_stopped: false,
      },
      linked_pull_requests: [
        {
          number: 31,
          title: "current attempt",
          state: "open",
          merged: false,
          html_url: "/pulls/31",
          github_pull: null,
          cost_stopped: false,
          draft: false,
          additions: 24,
          deletions: 7,
          changed_files: 3,
          commits_ahead: 4,
          review_state: "PASSED",
          base_commits_behind: 2,
          cost_usd: 1.25,
        },
        {
          number: 30,
          title: "merged attempt",
          state: "closed",
          merged: true,
          html_url: "/pulls/30",
          github_pull: null,
          cost_stopped: false,
        },
        {
          number: 29,
          title: "closed attempt",
          state: "closed",
          merged: false,
          html_url: "/pulls/29",
          github_pull: null,
          cost_stopped: false,
        },
      ],
    };
    renderDetail(() => multiPr);

    expect(await screen.findByText("Linked pull requests")).toBeTruthy();
    expect(screen.getByText("PR #31")).toBeTruthy();
    expect(
      screen.getByLabelText("Linked PR #31: current attempt"),
    ).toBeTruthy();
    expect(screen.getByText("PR #30")).toBeTruthy();
    expect(screen.getByLabelText("Linked PR #30: merged attempt")).toBeTruthy();
    expect(screen.getByText("PR #29")).toBeTruthy();
    expect(screen.getByLabelText("Linked PR #29: closed attempt")).toBeTruthy();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("Diff")).toBeTruthy();
    expect(screen.getByText("+24")).toBeTruthy();
    expect(screen.getByText("−7")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("pass")).toBeTruthy();
    expect(screen.getByText("base is 2 commits behind")).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "Review & merge" }),
    ).not.toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Close" })).not.toHaveLength(
      0,
    );
    expect(screen.queryByText(/Discard/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New attempt" }));
    expect(
      screen.getByRole("button", { name: "Build with Claude Code" }),
    ).toBeTruthy();
    expect(screen.queryByText(/PR #31 is already in progress/)).toBeNull();
  });

  it("hides Diff and Review on linked PRs with no commits yet", async () => {
    const noCommits: Issue = {
      ...issue,
      linked_pull_requests: [
        {
          number: 31,
          title: "empty open attempt",
          state: "open",
          merged: false,
          html_url: "/pulls/31",
          github_pull: null,
          cost_stopped: false,
          draft: false,
          additions: 0,
          deletions: 0,
          changed_files: 0,
          commits_ahead: 0,
          review_state: "NONE",
          base_commits_behind: 0,
        },
        {
          number: 30,
          title: "empty closed attempt",
          state: "closed",
          merged: false,
          html_url: "/pulls/30",
          github_pull: null,
          cost_stopped: false,
          draft: false,
          additions: 0,
          deletions: 0,
          changed_files: 0,
          commits_ahead: 0,
          review_state: "NONE",
          base_commits_behind: 0,
        },
      ],
    };
    renderDetail(() => noCommits);

    // Both rows render, but the same rule applies to open and closed: no Diff,
    // no Review while the attempt has no commits.
    expect(
      await screen.findByLabelText("Linked PR #31: empty open attempt"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Linked PR #30: empty closed attempt"),
    ).toBeTruthy();
    expect(screen.queryByText("Diff")).toBeNull();
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByText("not reviewed")).toBeNull();
  });

  it("closes a linked PR immediately without confirmation", async () => {
    renderDetail(undefined, false, {
      "pulls/update": (params) => ({
        ...issue.linked_pull_request!,
        state: params.state,
      }),
    });

    const linkedPullRow = await screen.findByLabelText(
      "Linked PR #30: ui2: issue detail PR",
    );
    fireEvent.click(
      within(linkedPullRow).getByRole("button", { name: "Close" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() =>
      expect(rpcCall("pulls/update")).toMatchObject({
        params: {
          repo: "me/proj",
          number: 30,
          state: "closed",
        },
      }),
    );
    await waitFor(() => {
      const issueGets = (
        fetch as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => {
        const body = JSON.parse(String((call[1] as RequestInit).body));
        return body.method === "issues/get";
      });
      expect(issueGets.length).toBeGreaterThan(1);
    });
  });

  it("explains when old attempt rows are omitted by the detail limit", async () => {
    renderDetail(() => ({
      ...issue,
      linked_pull_requests: [issue.linked_pull_request!],
      linked_pull_requests_truncated: true,
    }));

    expect(
      await screen.findByText(
        "Showing the 1 most relevant attempts to keep this page responsive.",
      ),
    ).toBeTruthy();
  });

  it("keeps inactive and active linked PRs at normal opacity", async () => {
    renderDetail(() => ({
      ...issue,
      linked_pull_requests: [
        issue.linked_pull_request!,
        {
          ...issue.linked_pull_request!,
          number: 29,
          title: "merged attempt",
          state: "closed",
          merged: true,
        },
      ],
    }));

    const activeContent = (
      await screen.findByLabelText("Linked PR #30: ui2: issue detail PR")
    ).querySelector("[data-linked-pull-content]");
    const inactiveContent = screen
      .getByLabelText("Linked PR #29: merged attempt")
      .querySelector("[data-linked-pull-content]");
    expect(activeContent?.className).not.toContain("opacity-45");
    expect(inactiveContent?.className).not.toContain("opacity-45");
  });

  it("focuses the linked-PR Herdr pane from the hover popover", async () => {
    renderDetail(undefined, false, {
      "terminal/sessions": () => ({
        repos: [
          {
            repo: "me/proj",
            session_name: "lh-me-proj",
            agents: [{ id: "%7", name: "dev #12", status: "working" }],
            pull_workspaces: [{ pull: 30, pane_id: "%7", status: "working" }],
          },
        ],
      }),
      "terminal/focusAgent": () => ({ ok: true }),
    });

    expect(await screen.findByText("PR #30")).toBeTruthy();
    openLinkedPullPopover("Linked PR #30: ui2: issue detail PR");
    fireEvent.click(screen.getByRole("button", { name: "Open in Herdr" }));
    await waitFor(() => {
      expect(rpcCall("terminal/focusAgent")?.params).toEqual({
        repo: "me/proj",
        paneId: "%7",
      });
    });
  });

  it("does not treat a blocked linked-PR Herdr workspace as working", async () => {
    renderDetail(undefined, false, {
      "terminal/sessions": () => ({
        repos: [
          {
            repo: "me/proj",
            session_name: "lh-me-proj",
            agents: [{ id: "%7", name: "dev #12", status: "blocked" }],
            pull_workspaces: [{ pull: 30, pane_id: "%7", status: "blocked" }],
          },
        ],
      }),
    });

    expect(await screen.findByText("PR #30")).toBeTruthy();
    expect(screen.queryByText("working")).toBeNull();
    openLinkedPullPopover("Linked PR #30: ui2: issue detail PR");
    expect(screen.getByText("Herdr").nextSibling?.textContent).toBe("blocked");
  });

  it("shows no Herdr badge on the linked-PR row when no herdr session runs the PR", async () => {
    renderDetail(undefined, false, {
      "terminal/sessions": () => ({ repos: [] }),
    });

    expect(await screen.findByText("PR #30")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Focus terminal/ })).toBeNull();
  });

  it("posts a comment and clears the textarea on success", async () => {
    renderDetail();

    const textarea = (await screen.findByLabelText(
      "Add a comment",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Nice work" } });

    const button = screen.getByRole("button", { name: /comment/i });
    fireEvent.click(button);

    await waitFor(() => {
      const call = rpcCall("comments/create");
      expect(call).toBeTruthy();
      expect(call!.params.body).toContain("Nice work");
    });

    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("replaces the Build button with a disabled Building label when an open PR is linked", async () => {
    // The default issue has an open linked PR (#30).
    renderDetail();

    // Building renders, so the header is mounted — Build must be absent.
    await screen.findByText("Building");
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
    expect(screen.getByText("Building")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New attempt" })).toBeTruthy();
  });

  it("replaces the Build button with a disabled Merged label when the linked PR is merged", async () => {
    const merged: Issue = {
      ...issue,
      linked_pull_request: { ...issue.linked_pull_request!, merged: true },
    };
    renderDetail(() => merged);

    await screen.findByRole("button", { name: /close/i });
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
    expect(screen.getByText("Merged")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New attempt" })).toBeNull();
  });

  it("shows the Build button when no PR is linked", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    expect(await screen.findByRole("button", { name: /^Build$/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New attempt" })).toBeNull();
  });

  it("hides the Build button in normal mode", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr, false, {}, false);

    await screen.findByRole("button", { name: /close/i });
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Start workflow" })).toBeTruthy();
  });

  // #1256: a closed issue starts no new work. Build / Start workflow / New
  // attempt and the Building/Merged status label are all hidden; only Reopen
  // remains until the issue is reopened.
  it("shows only Reopen on a closed issue, with no implementation-start actions", async () => {
    const closedNoPr: Issue = {
      ...issue,
      state: "closed",
      linked_pull_request: null,
    };
    renderDetail(() => closedNoPr, false, {
      "workflows/list": () => [{ id: 9, name: "Standard" }],
    });

    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New attempt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start workflow" })).toBeNull();
  });

  it("hides the Building label and New attempt on a closed issue with an open linked PR", async () => {
    // The default issue has an open linked PR (#30): open, this shows a Building
    // label plus New attempt. Closed, neither should appear — only Reopen.
    const closedWithOpenPr: Issue = { ...issue, state: "closed" };
    renderDetail(() => closedWithOpenPr);

    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.queryByText("Building")).toBeNull();
    expect(screen.queryByRole("button", { name: "New attempt" })).toBeNull();
  });

  it("shows workflow descriptions without requiring one and preserves selection behavior", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    const longDescription =
      "Runs implementation and independent verification with enough detail to wrap across several lines without widening the workflow menu.";
    renderDetail(() => noPr, false, {
      "workflows/list": () => [
        {
          id: 9,
          name: "Standard",
          description: "Implement the issue, then verify the result.",
        },
        { id: 10, name: "No description", description: null },
        { id: 11, name: "Detailed workflow", description: longDescription },
      ],
    });

    const button = await screen.findByRole("button", {
      name: "Start workflow",
    });
    expect(button.className).toContain("bg-primary");
    expect(button.className).toContain("text-primary-foreground");
    expect(button.title).toBe(
      "Start a saved workflow in auto mode (no approval prompts, no sandbox)",
    );

    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    const standard = await screen.findByRole("menuitem", {
      name: "Standard Implement the issue, then verify the result.",
    });
    expect(standard.className).toContain("px-3");
    expect(standard.className).toContain("py-3");
    expect(
      within(standard).getByText(
        "Implement the issue, then verify the result.",
      ),
    ).toBeTruthy();

    const noDescription = screen.getByRole("menuitem", {
      name: "No description",
    });
    expect(noDescription.textContent).toBe("No description");

    const detailed = screen.getByRole("menuitem", {
      name: `Detailed workflow ${longDescription}`,
    });
    expect(within(detailed).getByText(longDescription).className).toContain(
      "line-clamp-3",
    );

    fireEvent.click(standard);

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #12 - ui2: issue detail",
      workflow: "workflow-run",
      issueNumber: 12,
      workflowId: 9,
    });
  });

  it("shows the Build button when the only linked PR is closed-unmerged", async () => {
    const rejected: Issue = {
      ...issue,
      linked_pull_request: {
        ...issue.linked_pull_request!,
        state: "closed",
        merged: false,
      },
    };
    renderDetail(() => rejected);

    expect(await screen.findByRole("button", { name: /^Build$/ })).toBeTruthy();
  });

  it("launches `lh build <n> --herdr` in a terminal when the Build button is clicked", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    const button = await screen.findByRole("button", { name: /^Build$/ });
    fireEvent.click(button);

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #12 - ui2: issue detail",
      workflow: "issue-dev",
      issueNumber: 12,
    });
  });

  it("requires agent/model selection before launching a new attempt without confirmation", async () => {
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "New attempt" }));

    expect(launchTerminal).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Build with Claude Code" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Start a parallel attempt?" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Build with Claude Code" }),
    );

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #12 - ui2: issue detail",
      workflow: "issue-dev",
      issueNumber: 12,
      agent: "claude-code",
      model: "opus",
      newAttempt: true,
    });
    expect(
      screen.queryByRole("dialog", { name: "Start a parallel attempt?" }),
    ).toBeNull();
  });

  it("uses the selected agent/model for a new attempt", async () => {
    renderDetail();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Choose agent and model" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Model" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "gpt-5.6-sol" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Build with Codex" }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #12 - ui2: issue detail",
      workflow: "issue-dev",
      issueNumber: 12,
      agent: "codex",
      model: "gpt-5.6-sol",
      newAttempt: true,
    });
  });

  it("shows a neutral tooltip that does not expose the lh build command", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr, true);

    const button = await screen.findByRole("button", { name: /^Build$/ });

    expect(button.title).toBe("Build this issue in a terminal");
    expect(button.title).not.toContain("lh build");
  });

  it("launches Build with the model selected from the shadcn dropdown", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Choose agent and model" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Model" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "sonnet" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Build with Claude Code" }),
    );

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #12 - ui2: issue detail",
      workflow: "issue-dev",
      issueNumber: 12,
      agent: "claude-code",
      model: "sonnet",
    });
    expect(
      screen.queryByRole("button", { name: "Build with Claude Code" }),
    ).toBeNull();
  });

  it("launches Build with gpt-5.6-sol selected from the Codex model dropdown", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Choose agent and model" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Model" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "gpt-5.6-sol" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Build with Codex" }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #12 - ui2: issue detail",
      workflow: "issue-dev",
      issueNumber: 12,
      agent: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("launches Build with a custom one-shot model typed in the dropdown", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Choose agent and model" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.change(screen.getByLabelText("Custom model"), {
      target: { value: "vendor/custom-preview" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Build with Claude Code" }),
    );

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #12 - ui2: issue detail",
      workflow: "issue-dev",
      issueNumber: 12,
      agent: "claude-code",
      model: "vendor/custom-preview",
    });
  });

  it("closes the Build model menu with Escape from the custom model input", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Choose agent and model" }),
      { button: 0, ctrlKey: false },
    );
    const customModel = screen.getByLabelText("Custom model");
    customModel.focus();
    fireEvent.keyDown(customModel, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Build with Claude Code" }),
      ).toBeNull();
    });
  });

  it("shows a fixed-duration loading state on the Build button and re-enables it after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    const button = await screen.findByRole("button", { name: /^Build$/ });
    fireEvent.click(button);

    expect(button.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTION_LOADING_MS);
    });
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
  });
});
