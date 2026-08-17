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
import * as attachments from "@/api/attachments";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { Issue, IssueComment } from "@/api/types";
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  launchTerminal.mockClear();
});

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
    author_type: "agent",
    body: "Looks good.",
    created_at: "2026-06-17T11:30:00Z",
    reactions: [],
  },
  {
    id: 5,
    user: { login: "me" },
    author_type: "human",
    body: "Shipping it.",
    created_at: "2026-06-17T11:40:00Z",
    reactions: [],
  },
];

function mockFetch(
  getIssue: () => Issue = () => issue,
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  return mockRpcFetch({
    "workflowRuns/stateForPull": () => null,
    "terminal/sessions": () => ({ repos: [] }),
    "worker/status": () => ({
      status: "compatible",
      required_protocol_version: 1,
      observed_protocol_version: 1,
      started_at: "2026-08-02T00:00:00Z",
      heartbeat_at: "2026-08-02T00:00:01Z",
    }),
    // #2263: the linked-PR rows read their tokens/cost from this git-free query rather than the
    // issue payload. Answering it by default keeps every other test on the issue's own numbers.
    "pulls/usage": (p: any) => ({ number: p.number }),
    "issues/ac/list": () =>
      (getIssue().acceptance_criteria ?? []).map((criterion) => ({
        ...criterion,
        enabled: true,
      })),
    "repos/agentConfig": () => ({
      setting: { override: false, runtime: null, model: null, effort: null },
      effective: { runtime: "claude-code", model: "opus", effort: "medium" },
    }),
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
        "claude-code": { model: "opus", effort: "medium" },
        codex: {
          model: "gpt-5.5",
          effort: "medium",
        },
        grok: { model: "grok-4.5", effort: "medium" },
        opencode: {
          model: "opencode/big-pickle",
          effort: "medium",
        },
      },
      codingAgent: "claude-code",
    }),
  });
}

function renderDetail(
  getIssue?: () => Issue,
  extraHandlers: Record<string, (params: any) => unknown> = {},
  initialEntries: string[] = ["/"],
) {
  vi.stubGlobal("fetch", mockFetch(getIssue, extraHandlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  let setIssueNumber = (_number: number) => {};
  function DetailRoute() {
    const [number, setNumber] = useState(12);
    setIssueNumber = setNumber;
    return (
      <WebConfigProvider config={{ debug: false }}>
        <IssueDetail owner="me" repo="proj" number={number} />
      </WebConfigProvider>
    );
  }
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: DetailRoute,
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
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      pullsRoute,
      issuesRoute,
      repoRoute,
    ]),
    history: createMemoryHistory({ initialEntries }),
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    ...rendered,
    router,
    queryClient,
    switchIssue: (number: number) => setIssueNumber(number),
  };
}

describe("IssueDetail", () => {
  it("renders title, body, labels, comments, and the linked PR summary", async () => {
    renderDetail();

    expect(await screen.findByText("ui2: issue detail")).toBeTruthy();
    expect(document.title).toBe(
      "Issue #12 · ui2: issue detail · me/proj · LoopHub",
    );
    expect(screen.getByText("Render title, body, labels.")).toBeTruthy();
    expect(screen.getByText("ready-to-build")).toBeTruthy();
    expect(screen.queryByText(/^branch:/)).toBeNull();
    expect(screen.getByText("Looks good.")).toBeTruthy();

    const prLink = screen.getByRole("link", { name: "PR #30" });
    expect(prLink.getAttribute("href")).toBe("/r/me/proj/pulls/30");
    expect(
      screen.getByLabelText("Linked PR #30: ui2: issue detail PR"),
    ).toBeTruthy();
    // Match Issue list: no inline PR title on the linked-PR row (#32).
    expect(
      screen.queryByRole("link", { name: "ui2: issue detail PR" }),
    ).toBeNull();
    expect(screen.queryByText("Workflow run")).toBeNull();
  });

  it("renders direct sub issues with the shared issue row and ancestor breadcrumb", async () => {
    const child: Issue = {
      ...issue,
      number: 13,
      title: "child issue",
      linked_pull_request: null,
      has_open_pull_request: false,
      ancestors: [
        { number: 2, title: "top issue", state: "open" },
        { number: 3, title: "root issue", state: "open" },
      ],
    };
    renderDetail(
      () => ({
        ...issue,
        ancestors: [
          { number: 2, title: "top issue", state: "open" },
          { number: 3, title: "root issue", state: "open" },
        ],
      }),
      { "issues/subIssues": () => [child] },
    );

    expect(await screen.findByText("Sub issues")).toBeTruthy();
    expect(screen.getByLabelText("Issue #13: child issue")).toBeTruthy();
    expect(screen.getByRole("link", { name: "#3" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "#2" })).toBeTruthy();
    expect(screen.getAllByText("›")).toHaveLength(1);
  });

  it("shows an error when sub issues cannot be loaded", async () => {
    renderDetail(undefined, {
      "issues/subIssues": () => {
        throw new Error("sub issues unavailable");
      },
    });

    expect(await screen.findByText("Failed to load sub issues.")).toBeTruthy();
  });

  it("offers to create a sub issue when the parent has no children", async () => {
    renderDetail(undefined, { "issues/subIssues": () => [] });

    await screen.findByText("ui2: issue detail");
    expect(screen.getByText("Sub issues")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New issue" }));
    expect(launchTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ parentIssue: 12 }),
    );
  });

  it("hides the sub issue action at the maximum depth", async () => {
    renderDetail(() => ({ ...issue, depth: 3 }), {
      "issues/subIssues": () => [],
    });

    await screen.findByText("ui2: issue detail");
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
    expect(screen.queryByText("Sub issues")).toBeNull();
  });

  it("opens a linked PR Workflow step pane from the issue detail", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetail(undefined, {
      "workflowRuns/stateForPull": () => ({
        id: 41,
        workflow_id: 7,
        workflow_name: "Build",
        status: "running",
        current_step: "execute",
        rework_count: 0,
        rework_limit: 8,
        cost_increment_usd: 10,
        cost_limit_usd: 10,
        cost_limit_increase_available: false,
        needs_human_reason: null,
        issue_number: 12,
        pr_number: 30,
        created_at: "2026-07-20T00:00:00Z",
        updated_at: "2026-07-20T00:00:00Z",
        latest_review: null,
        verification_status: "unverified",
      }),
      "terminal/sessions": () => ({
        repos: [
          {
            repo: "me/proj",
            session_name: "lh-me-proj",
            agents: [
              {
                id: "w1:p2",
                name: "executor #41-1",
                status: "working",
                pull: 30,
                pull_closed: false,
                focusable: true,
                workflow: {
                  kind: "step",
                  runId: 41,
                  step: "execute",
                  sequence: 1,
                },
              },
            ],
            pull_workspaces: [],
            issue_workspaces: [],
          },
        ],
      }),
      "terminal/focusAgent": () => ({ ok: true }),
    });

    const row = await screen.findByLabelText(
      "Linked PR #30: ui2: issue detail PR",
    );
    const execute = within(row).getByText("Execute");
    fireEvent.mouseEnter(execute.parentElement!);
    act(() => vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS));

    const dialog = screen.getByRole("dialog", {
      name: "Execute workflow step details",
    });
    expect(within(dialog).getByText("Run #41")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open in Herdr" }),
    );
    await waitFor(() => {
      expect(rpcCall("terminal/focusAgent")?.params).toEqual({
        repo: "me/proj",
        paneId: "w1:p2",
      });
    });
  });

  // #1828: the same budget action is reachable from the issue page's linked-PR row.
  it("increases a cost-held linked run's budget from the issue page", async () => {
    renderDetail(undefined, {
      "workflowRuns/stateForPull": () => ({
        id: 41,
        workflow_id: 7,
        workflow_name: "Build",
        status: "running",
        current_step: "execute",
        rework_count: 0,
        rework_limit: 8,
        cost_increment_usd: 10,
        cost_limit_usd: 20,
        cost_limit_increase_available: true,
        needs_human_reason: "Cost limit exceeded",
        issue_number: 12,
        pr_number: 30,
        created_at: "2026-07-20T00:00:00Z",
        updated_at: "2026-07-20T00:00:00Z",
        latest_review: null,
        verification_status: "unverified",
      }),
      "workflowRuns/increaseCostLimit": () => ({
        run: 41,
        increment_usd: 10,
        previous_limit_usd: 20,
        current_limit_usd: 30,
      }),
    });

    // #1906: the row carries only the badge; the question opens from it.
    fireEvent.focus(await screen.findByText("over budget"));
    const prompt = screen.getByRole("group", { name: "Increase to $30.00?" });
    const action = within(prompt).getByRole("button", { name: "Yes" });
    await act(async () => {
      fireEvent.click(action);
    });

    expect(rpcCall("workflowRuns/increaseCostLimit")?.params).toMatchObject({
      repo: "me/proj",
      run: 41,
      expected_limit_usd: 20,
    });
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

  // #2129: a human post reads as @human whatever actor name it was stored under; agent posts keep
  // their own author.
  it("shows a human comment as @human and leaves an agent comment alone", async () => {
    renderDetail();

    const human = (await screen.findByText("Shipping it.")).closest("article");
    expect(human?.textContent).toContain("@human");
    expect(human?.textContent).not.toContain("@me");
    expect(
      within(human as HTMLElement).queryByLabelText("AI agent"),
    ).toBeNull();

    const agent = screen.getByText("Looks good.").closest("article");
    expect(agent?.textContent).toContain("@design-bot");
    expect(
      within(agent as HTMLElement).getByLabelText("AI agent"),
    ).toBeTruthy();
  });

  it("keeps bottom spacing after the comments section", async () => {
    renderDetail();

    const textarea = await screen.findByLabelText("Add a comment");
    const commentsSection = textarea.closest("section");

    expect(commentsSection?.id).toBe("comments");
    expect(commentsSection?.className).toContain("pb-6");
    expect(commentsSection?.textContent).toContain("Looks good.");
  });

  it("copies an issue comment's markdown from its three dots menu", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderDetail();

    fireEvent.pointerDown(
      await screen.findByLabelText("Actions for issue comment 1"),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy as Markdown" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Looks good."));
  });

  // #2151: documents (not just pasted images) can be attached from the UI.
  it("attaches a document picked with the file picker to the comment body", async () => {
    const sha = "d".repeat(64);
    const upload = vi.spyOn(attachments, "uploadAttachment").mockResolvedValue({
      sha256: sha,
      filename: "findings.md",
      mime: "text/markdown",
      size: 7,
      url: `/attachments/${sha}`,
      markdown: `[findings.md](/attachments/${sha})`,
    });
    renderDetail();

    const textarea = (await screen.findByLabelText(
      "Add a comment",
    )) as HTMLTextAreaElement;
    const picker = screen.getByLabelText("Attach a file") as HTMLInputElement;
    const doc = new File(["# notes"], "findings.md", { type: "text/markdown" });
    fireEvent.change(picker, { target: { files: [doc] } });

    await waitFor(() =>
      expect(textarea.value).toBe(`[findings.md](/attachments/${sha})\n`),
    );
    expect(upload).toHaveBeenCalledOnce();
  });

  it("does not navigate with the removed u shortcut", async () => {
    const { router } = renderDetail();

    expect(await screen.findByText("ui2: issue detail")).toBeTruthy();
    fireEvent.keyDown(window, { key: "u" });

    expect(router.state.location.pathname).toBe("/");
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
    renderDetail(() => ({ ...issue, herdr_pane: null }), {
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
    expect(screen.queryByText("Herdr")).toBeNull();
  });

  it("does not render the issue Sessions section", async () => {
    renderDetail(() => ({
      ...issue,
      related_sessions: [
        {
          id: "session-1",
          agent: "issue-create",
          session: "session-1",
          created_at: "2026-06-17T10:00:00Z",
          updated_at: "2026-06-17T10:00:00Z",
          kind: "issue-create",
          linked_at: "2026-06-17T11:00:00Z",
        },
      ],
    }));

    await screen.findByText("ui2: issue detail");
    expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
    expect(screen.queryByText("issue-create")).toBeNull();
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
    expect(screen.queryByText("Diff")).toBeNull();
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByText("base is 2 commits behind")).toBeNull();
    expect(screen.queryByRole("link", { name: "Review & merge" })).toBeNull();
    expect(
      within(
        screen.getByLabelText("Linked PR #31: current attempt"),
      ).queryByRole("button", { name: "Close" }),
    ).toBeNull();
    // Match Issue list: linked-PR rows omit the PR title link (#32).
    expect(screen.queryByRole("link", { name: "current attempt" })).toBeNull();
    expect(screen.queryByRole("link", { name: "merged attempt" })).toBeNull();
    expect(screen.queryByRole("link", { name: "closed attempt" })).toBeNull();
    expect(screen.queryByText(/Discard/)).toBeNull();
  });

  it("opens the archived pull request history in a dialog", async () => {
    renderDetail(() => ({
      ...issue,
      archived_pull_requests: [
        {
          ...issue.linked_pull_request!,
          number: 28,
          title: "archived attempt",
          state: "closed",
        },
      ],
    }));

    const trigger = await screen.findByRole("button", {
      name: "Archived pull requests (1)",
    });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", {
      name: "Archived pull requests",
    });
    expect(
      within(dialog).getByRole("link", { name: "PR #28" }).getAttribute("href"),
    ).toBe("/r/me/proj/pulls/28");
    expect(
      within(dialog)
        .getByRole("link", { name: "archived attempt" })
        .getAttribute("href"),
    ).toBe("/r/me/proj/pulls/28");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Close archived pull requests",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // #2340: the dialog is a way back to an archived attempt, not a status board. The row
  // keeps number, title and Unarchive; the live row's agent/usage metadata is dropped.
  it("keeps the archived row to number, title and Unarchive (#2340)", async () => {
    renderDetail(() => ({
      ...issue,
      archived_pull_requests: [
        {
          ...issue.linked_pull_request!,
          number: 28,
          title: "archived attempt",
          state: "closed",
          agent_model: "composer-1",
          total_tokens: 12_000,
          cost_usd: 3.4,
        },
      ],
    }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Archived pull requests (1)",
      }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Archived pull requests",
    });
    expect(within(dialog).getByRole("link", { name: "PR #28" })).toBeTruthy();
    expect(
      within(dialog).getByRole("link", { name: "archived attempt" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Unarchive" }),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Cursor/)).toBeNull();
    expect(within(dialog).queryByText(/composer-1/)).toBeNull();
    expect(within(dialog).queryByText("12k")).toBeNull();
    expect(within(dialog).queryByText("$3")).toBeNull();
    expect(
      within(dialog).queryByText(
        "Previous attempts remain available with their complete history.",
      ),
    ).toBeNull();
  });

  it("unarchives a pull request from the archived history dialog", async () => {
    renderDetail(
      () => ({
        ...issue,
        archived_pull_requests: [
          {
            ...issue.linked_pull_request!,
            number: 28,
            title: "archived attempt",
            state: "closed",
          },
        ],
      }),
      { "pulls/unarchive": () => ({ ok: true }) },
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Archived pull requests (1)",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));

    await waitFor(() => expect(rpcCall("pulls/unarchive")).toBeTruthy());
    expect(rpcCall("pulls/unarchive")!.params).toMatchObject({
      repo: "me/proj",
      number: 28,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps an archived pull visible when unarchive is rejected", async () => {
    renderDetail(
      () => ({
        ...issue,
        archived_pull_requests: [
          {
            ...issue.linked_pull_request!,
            number: 28,
            title: "archived attempt",
            state: "open",
          },
        ],
      }),
      {
        "pulls/unarchive": () => {
          throw new RpcFault(422, "Issue already has an open pull request");
        },
      },
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Archived pull requests (1)",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));

    expect(
      await screen.findByText("Issue already has an open pull request"),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  // #2263: a running agent's usage counter ticks every few seconds. Its event now invalidates only
  // the PR's usage query, so the row has to take its tokens/cost from there — the issue payload it
  // rides on is rebuilt from live git and is no longer refetched for a usage tick.
  it("shows the linked PR's tokens/cost from the usage query (#2263)", async () => {
    let usage: Record<string, unknown> = {
      number: 30,
      total_tokens: 12_000,
      cost_usd: 3.4,
    };
    const { queryClient } = renderDetail(() => issue, {
      "pulls/usage": () => usage,
    });

    const row = await screen.findByLabelText(
      "Linked PR #30: ui2: issue detail PR",
    );
    await waitFor(() => expect(within(row).getByText("12k")).toBeTruthy());
    expect(within(row).getByText("$3")).toBeTruthy();

    // What a usage_updated event does now: refresh that key alone.
    usage = { number: 30, total_tokens: 34_000, cost_usd: 9.6 };
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["pull-usage", "me/proj", 30],
      });
    });

    await waitFor(() => expect(within(row).getByText("34k")).toBeTruthy());
    expect(within(row).getByText("$10")).toBeTruthy();
  });

  it("explains when old linked PR rows are omitted by the detail limit", async () => {
    renderDetail(() => ({
      ...issue,
      linked_pull_requests: [issue.linked_pull_request!],
      linked_pull_requests_truncated: true,
    }));

    expect(
      await screen.findByText(
        "Showing the 1 most relevant pull requests to keep this page responsive.",
      ),
    ).toBeTruthy();
  });

  it("dims inactive linked PRs but keeps active linked PRs opaque", async () => {
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

    // Dim lives on the content wrapper (not the row) so PullPopover stays opaque (#32).
    const activeContent = (
      await screen.findByLabelText("Linked PR #30: ui2: issue detail PR")
    ).querySelector("[data-linked-pull-content]");
    const inactiveContent = screen
      .getByLabelText("Linked PR #29: merged attempt")
      .querySelector("[data-linked-pull-content]");
    expect(activeContent?.className).not.toContain("opacity-45");
    expect(inactiveContent?.className).toContain("opacity-45");
  });

  it("opens the PullPopover from the PR link only, not the whole row", async () => {
    renderDetail();
    const row = await screen.findByLabelText(
      "Linked PR #30: ui2: issue detail PR",
    );
    const link = screen.getByRole("link", { name: "PR #30" });
    expect(row.className).not.toContain("hover:bg-");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(row);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS * 2);
    });
    expect(
      document.querySelector('[data-debug-component="PullPopover"]'),
    ).toBeNull();

    fireEvent.mouseEnter(link);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(
      document.querySelector('[data-debug-component="PullPopover"]'),
    ).toBeTruthy();
  });

  it("shows no Herdr badge on the linked-PR row when no herdr session runs the PR", async () => {
    renderDetail(undefined, {
      "terminal/sessions": () => ({ repos: [] }),
    });

    expect(await screen.findByText("PR #30")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Focus terminal/ })).toBeNull();
  });

  it("shows active acceptance criteria with stable numbers and authoring controls", async () => {
    const withCriteria: Issue = {
      ...issue,
      acceptance_criteria: [
        { id: 11, number: 1, ordinal: 1, text: "AC is editable" },
        { id: 12, number: 2, ordinal: 2, text: "grades join to the AC text" },
      ],
    };
    renderDetail(() => withCriteria);

    await screen.findByText("AC is editable");
    const block = (await screen.findByText("Acceptance criteria")).closest(
      "[data-debug-component='IssueAcceptanceCriteria']",
    ) as HTMLElement;
    const items = within(block).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "AC is editableAC 1",
      "grades join to the AC textAC 2",
    ]);
    expect(
      within(block).getByRole("button", { name: "Actions for AC 1" }),
    ).toBeTruthy();
    expect(
      within(block).getByRole("button", { name: "Actions for AC 2" }),
    ).toBeTruthy();
    expect(
      within(block).getByRole("textbox", { name: "New acceptance criterion" }),
    ).toBeTruthy();
    // #2414: form is relative so the sr-only absolute label cannot expand document scroll.
    expect(
      within(block)
        .getByRole("textbox", { name: "New acceptance criterion" })
        .closest("form")?.className,
    ).toContain("relative");
    expect(
      (within(block).getByRole("button", { name: "Add" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(block).queryByRole("checkbox")).toBeNull();
    // Same box as the issue body, and ahead of the Close action.
    const box = block.parentElement as HTMLElement;
    expect(box.textContent).toContain("Render title, body, labels.");
    expect(
      block.compareDocumentPosition(
        screen.getByRole("button", { name: "Close" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders acceptance criteria authoring when the issue has none", async () => {
    renderDetail();

    expect(await screen.findByText("ui2: issue detail")).toBeTruthy();
    expect(screen.getByText("Acceptance criteria")).toBeTruthy();
    expect(
      await screen.findByText("No active acceptance criteria."),
    ).toBeTruthy();
  });

  it("resets acceptance criteria authoring state when the issue changes", async () => {
    let currentIssue = issue;
    const { switchIssue } = renderDetail(() => currentIssue, {
      "issues/ac/list": (params) =>
        params.number === 12
          ? [
              {
                id: 41,
                number: 3,
                ordinal: 1,
                text: "Disabled on issue 12",
                enabled: false,
              },
            ]
          : [],
      "issues/ac/add": (params) => ({
        id: 42,
        number: 1,
        ordinal: 1,
        text: params.text,
        enabled: true,
      }),
    });

    await screen.findByText("No active acceptance criteria.");
    fireEvent.change(
      screen.getByRole("textbox", { name: "New acceptance criterion" }),
      { target: { value: "Draft for issue 12" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Show disabled (1)" }));
    expect(screen.getByText("Disabled on issue 12")).toBeTruthy();

    currentIssue = {
      ...issue,
      number: 13,
      title: "Issue 13",
      linked_pull_request: null,
    };
    act(() => switchIssue(13));

    await screen.findByText("Issue 13");
    const input = screen.getByRole("textbox", {
      name: "New acceptance criterion",
    }) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.queryByText("Disabled on issue 12")).toBeNull();

    fireEvent.change(input, { target: { value: "Criterion for issue 13" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(rpcCall("issues/ac/add")?.params).toMatchObject({
        number: 13,
        text: "Criterion for issue 13",
      }),
    );
  });

  it("keeps the detail loading while the complete criteria list is loading", async () => {
    renderDetail(undefined, {
      "issues/ac/list": () => new Promise(() => {}),
    });

    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "New acceptance criterion" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for AC/ })).toBeNull();
  });

  it("shows a page error when the complete criteria list fails", async () => {
    renderDetail(
      () => ({
        ...issue,
        acceptance_criteria: [
          { id: 41, number: 1, ordinal: 1, text: "Enabled-only fallback" },
        ],
      }),
      {
        "issues/ac/list": () => {
          throw new RpcFault(503, "Complete criteria are unavailable");
        },
      },
    );

    expect(
      await screen.findByText(/Complete criteria are unavailable/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "New acceptance criterion" }),
    ).toBeNull();
    expect(screen.queryByText("Enabled-only fallback")).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for AC/ })).toBeNull();
  });

  it("adds a non-blank acceptance criterion and refreshes issue data", async () => {
    renderDetail(undefined, {
      "issues/ac/add": (params) => ({
        id: 21,
        number: 1,
        ordinal: 1,
        text: params.text,
        enabled: true,
      }),
    });

    const input = (await screen.findByRole("textbox", {
      name: "New acceptance criterion",
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  New behavior  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(rpcCall("issues/ac/add")?.params).toMatchObject({
        repo: "me/proj",
        number: 12,
        text: "New behavior",
      }),
    );
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps an acceptance criterion draft and shows RPC failures", async () => {
    renderDetail(undefined, {
      "issues/ac/add": () => {
        throw new RpcFault(422, "Criterion could not be added");
      },
    });

    const input = (await screen.findByRole("textbox", {
      name: "New acceptance criterion",
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText("Criterion could not be added"),
    ).toBeTruthy();
    expect(input.value).toBe("Keep this draft");
  });

  it("shows only the latest acceptance criteria mutation error", async () => {
    let addAttempt = 0;
    renderDetail(undefined, {
      "issues/ac/list": () => [
        {
          id: 61,
          number: 5,
          ordinal: 1,
          text: "Restore candidate",
          enabled: false,
        },
      ],
      "issues/ac/add": () => {
        addAttempt += 1;
        throw new RpcFault(422, `Add failure ${addAttempt}`);
      },
      "issues/ac/setEnabled": () => {
        throw new RpcFault(500, "Restore failure");
      },
    });

    const input = (await screen.findByRole("textbox", {
      name: "New acceptance criterion",
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "First attempt" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Add failure 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show disabled (1)" }));
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for AC 5" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Restore criterion" }),
    );
    expect(await screen.findByText("Restore failure")).toBeTruthy();
    expect(screen.queryByText("Add failure 1")).toBeNull();

    fireEvent.change(input, { target: { value: "Second attempt" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Add failure 2")).toBeTruthy();
    expect(screen.queryByText("Restore failure")).toBeNull();
  });

  it("disables from the action menu and restores a disabled criterion", async () => {
    const criteria = [
      {
        id: "12-4",
        number: 4,
        ordinal: 1,
        text: "Stable history",
        enabled: true,
      },
      {
        id: "12-7",
        number: 7,
        ordinal: 2,
        text: "Previously disabled",
        enabled: false,
      },
    ];
    renderDetail(undefined, {
      "issues/ac/list": () => criteria,
      "issues/ac/setEnabled": (params) => ({
        ...criteria.find((criterion) => criterion.id === params.criterion_id),
        enabled: params.enabled,
      }),
    });

    await screen.findByText("Stable history");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for AC 4" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Disable criterion" }),
    );
    await waitFor(() =>
      expect(rpcCall("issues/ac/setEnabled")?.params).toMatchObject({
        number: 12,
        criterion_id: "12-4",
        enabled: false,
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show disabled (1)" }));
    expect(screen.getByText("Previously disabled")).toBeTruthy();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for AC 7" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Restore criterion" }),
    );
    await waitFor(() => {
      const calls = (
        fetch as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.map((call) =>
        JSON.parse(String((call[1] as RequestInit).body)),
      );
      expect(
        calls.some(
          (call) =>
            call.method === "issues/ac/setEnabled" &&
            call.params.criterion_id === "12-7" &&
            call.params.enabled === true,
        ),
      ).toBe(true);
    });
  });

  it("shows a disable RPC failure in the acceptance criteria section", async () => {
    renderDetail(
      () => ({
        ...issue,
        acceptance_criteria: [
          { id: "12-3", number: 3, ordinal: 1, text: "Cannot disable" },
        ],
      }),
      {
        "issues/ac/setEnabled": () => {
          throw new RpcFault(500, "Disable request failed");
        },
      },
    );

    await screen.findByText("Cannot disable");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for AC 3" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Disable criterion" }),
    );

    expect(await screen.findByText("Disable request failed")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("posts a comment and clears the textarea on success", async () => {
    renderDetail();

    const textarea = (await screen.findByLabelText(
      "Add a comment",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Nice work" } });

    const button = screen.getByRole("button", { name: "Comment" });
    fireEvent.click(button);

    await waitFor(() => {
      const call = rpcCall("comments/create");
      expect(call).toBeTruthy();
      expect(call!.params.body).toContain("Nice work");
      // #2129: posted as the supervising human, not as an unregistered browser session.
      expect(call!.params.session_id).toBeUndefined();
    });

    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("posts a non-empty comment once with Cmd+Enter but not Enter alone", async () => {
    renderDetail();

    const textarea = (await screen.findByLabelText(
      "Add a comment",
    )) as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(rpcCall("comments/create")).toBeUndefined();

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(rpcCall("comments/create")).toBeUndefined();

    fireEvent.change(textarea, { target: { value: "Keyboard comment" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => {
      const calls = (
        fetch as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => {
        const request = JSON.parse(
          String((call[1] as RequestInit | undefined)?.body),
        );
        return request.method === "comments/create";
      });
      expect(calls).toHaveLength(1);
      expect(
        JSON.parse(String((calls[0][1] as RequestInit).body)).params.body,
      ).toBe("Keyboard comment");
    });
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("shows Start workflow (and no Build) on an open issue with no linked PR", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    expect(
      await screen.findByRole("button", { name: "Start workflow" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New attempt" })).toBeNull();
  });

  it("disables Start workflow and explains remediation when the worker is stale", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr, {
      "worker/status": () => ({
        status: "stale",
        required_protocol_version: 1,
        observed_protocol_version: 1,
        started_at: "2026-08-02T00:00:00Z",
        heartbeat_at: "2026-08-02T00:00:01Z",
      }),
    });

    expect(
      (await screen.findByRole("button", {
        name: "Start workflow",
      })) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByText(
        "Start or restart lh-worker to enable workflow launches.",
      ),
    ).toBeTruthy();
  });

  it("shows no implementation-start control on an open issue with an open linked PR", async () => {
    // The default issue has an open linked PR (#30): no Start workflow, no
    // Build, no Building/Merged status label — only the header Close action.
    renderDetail();

    await screen.findByRole("button", { name: /close/i });
    expect(screen.queryByRole("button", { name: "Start workflow" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New attempt" })).toBeNull();
    expect(screen.queryByText("Building")).toBeNull();
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
    renderDetail(() => closedNoPr, {
      "workflows/list": () => [
        { id: 9, name: "Standard", scope: { kind: "global" } },
      ],
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

  it("shows workflow descriptions without requiring one and launches on one click", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    const longDescription =
      "Runs implementation and independent verification with enough detail to wrap across several lines without widening the workflow menu.";
    renderDetail(() => noPr, {
      "workflows/list": () => [
        {
          id: 9,
          name: "Standard",
          description: "Implement the issue, then verify the result.",
          scope: { kind: "global" },
        },
        {
          id: 10,
          name: "No description",
          description: null,
          scope: {
            kind: "repository",
            repo: { id: 1, owner: "me", name: "proj" },
          },
        },
        {
          id: 11,
          name: "Detailed workflow",
          description: longDescription,
          scope: { kind: "global" },
        },
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
      name: /No description/,
    });
    expect(noDescription.textContent).toBe("No descriptionme/proj");
    expect(within(noDescription).getByText("me/proj")).toBeTruthy();

    const detailed = screen.getByRole("menuitem", {
      name: `Detailed workflow ${longDescription}`,
    });
    expect(within(detailed).getByText(longDescription).className).toContain(
      "line-clamp-3",
    );

    // Selecting a workflow launches immediately with the repo effective
    // agent/model (no one-shot override fields on the launch call).
    fireEvent.click(standard);

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #12 - ui2: issue detail",
      workflow: "workflow-run",
      issueNumber: 12,
      workflowId: 9,
    });
    expect(launchTerminal.mock.calls[0][0]).not.toHaveProperty("agent");
    expect(launchTerminal.mock.calls[0][0]).not.toHaveProperty("model");
  });

  it("shows the repository workflow that overrides a same-name global workflow", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr, {
      "workflows/list": () => [
        {
          id: 21,
          name: "Standard",
          description: "Repository loop",
          scope: {
            kind: "repository",
            repo: { id: 1, owner: "me", name: "proj" },
          },
        },
      ],
    });

    const button = await screen.findByRole("button", {
      name: "Start workflow",
    });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    const choices = await screen.findAllByRole("menuitem", {
      name: /Standard/,
    });
    expect(choices).toHaveLength(1);
    const repoLabel = within(choices[0]).getByText("me/proj");
    const nameLabel = within(choices[0]).getByText("Standard");
    expect(repoLabel.parentElement).toBe(nameLabel.parentElement);
    expect(repoLabel.parentElement?.className).toContain("flex");
    fireEvent.click(choices[0]);

    expect(launchTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 21 }),
    );
    expect(rpcCall("workflows/list")?.params).toMatchObject({
      applicable_to_repo: "me/proj",
    });
  });

  // #96: launching uses the repo effective Coding agent config (override on → repo values,
  // off → Settings defaults), so the picker surfaces the resolved runtime/model/effort as a
  // muted footer instead of letting the run start blind.
  it("shows the effective Coding agent config as a muted footer in the workflow menu", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr, {
      "workflows/list": () => [
        {
          id: 9,
          name: "Standard",
          description: "Implement the issue, then verify the result.",
          scope: { kind: "global" },
        },
      ],
    });

    const button = await screen.findByRole("button", {
      name: "Start workflow",
    });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    await screen.findByRole("menuitem", {
      name: /Standard Implement the issue, then verify the result./,
    });

    const footer = screen.getByText("claude-code · opus · medium");
    expect(footer.className).toContain("text-muted-foreground");
    expect(footer.className).toContain("text-xs");
    expect(footer.className).toContain("text-right");
    expect(footer.className).toContain("px-1.5");
    expect(footer.className).toContain("py-1");
  });

  // #96: the effective config is fetched independently of the workflow list; while it is still
  // loading (or fails) the menu must render and launch as before, just without the footer.
  it("keeps the workflow menu launching while the effective config is loading", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr, {
      "repos/agentConfig": () => new Promise(() => {}),
      "workflows/list": () => [
        {
          id: 9,
          name: "Standard",
          scope: { kind: "global" },
        },
      ],
    });

    const button = await screen.findByRole("button", {
      name: "Start workflow",
    });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    const standard = await screen.findByRole("menuitem", { name: "Standard" });
    expect(screen.queryByText(/claude-code · opus · medium/)).toBeNull();

    fireEvent.click(standard);
    expect(launchTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 9 }),
    );
  });

  // #96: with no saved workflows the empty state still shows the effective config so the
  // launch context stays visible, and the dropdown keeps working.
  it("shows the effective config footer with no saved workflows", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr, { "workflows/list": () => [] });

    const button = await screen.findByRole("button", {
      name: "Start workflow",
    });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });

    expect(
      await screen.findByText("No saved workflows — set one up in Settings"),
    ).toBeTruthy();
    expect(screen.getByText("claude-code · opus · medium")).toBeTruthy();
  });
});

// An IssueRow's comment count links here with the `#comments` hash. The section only exists once
// the page's data has loaded, so the page brings it into view itself (parity with #2394 on PRs).
describe("IssueDetail — #comments landing", () => {
  async function commentsSection() {
    const textarea = await screen.findByLabelText("Add a comment");
    return textarea.closest("section");
  }

  it("scrolls the Comments section into view when the page opens on #comments", async () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    renderDetail(undefined, {}, ["/#comments"]);

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
