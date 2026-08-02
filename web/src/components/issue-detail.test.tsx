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
import * as attachments from "@/api/attachments";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
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
      },
      codingAgent: "claude-code",
    }),
  });
}

function renderDetail(
  getIssue?: () => Issue,
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  vi.stubGlobal("fetch", mockFetch(getIssue, extraHandlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <WebConfigProvider config={{ debug: false }}>
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
      screen
        .getByRole("link", { name: "ui2: issue detail PR" })
        .getAttribute("href"),
    ).toBe("/r/me/proj/pulls/30");
    expect(screen.queryByText("Workflow run")).toBeNull();
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

    expect(commentsSection?.className).toContain("pb-6");
    expect(commentsSection?.textContent).toContain("Looks good.");
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
    expect(
      screen
        .getByRole("link", { name: "current attempt" })
        .getAttribute("href"),
    ).toBe("/r/me/proj/pulls/31");
    expect(screen.queryByText(/Discard/)).toBeNull();
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

    const activeRow = await screen.findByLabelText(
      "Linked PR #30: ui2: issue detail PR",
    );
    const inactiveRow = screen.getByLabelText("Linked PR #29: merged attempt");
    expect(activeRow.className).not.toContain("opacity-45");
    expect(inactiveRow.className).not.toContain("opacity-45");
  });

  it("shows no Herdr badge on the linked-PR row when no herdr session runs the PR", async () => {
    renderDetail(undefined, {
      "terminal/sessions": () => ({ repos: [] }),
    });

    expect(await screen.findByText("PR #30")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Focus terminal/ })).toBeNull();
  });

  // Structured AC (#1897): a read-only checklist, divided from the body inside the same box and
  // above the issue actions. Authoring stays in the CLI, so it must not grow an add / remove /
  // reorder control.
  it("shows structured acceptance criteria as a read-only checklist under the body", async () => {
    const withCriteria: Issue = {
      ...issue,
      acceptance_criteria: [
        { id: 11, number: 1, ordinal: 1, text: "AC is shown read-only" },
        { id: 12, number: 2, ordinal: 2, text: "grades join to the AC text" },
      ],
    };
    renderDetail(() => withCriteria);

    const block = (await screen.findByText("Acceptance criteria")).closest(
      "[data-debug-component='IssueAcceptanceCriteria']",
    ) as HTMLElement;
    const items = within(block).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "AC is shown read-onlyAC 1",
      "grades join to the AC textAC 2",
    ]);
    expect(within(block).queryByRole("button")).toBeNull();
    expect(within(block).queryByRole("checkbox")).toBeNull();
    expect(within(block).queryByRole("textbox")).toBeNull();
    expect(
      within(block).queryByText("Read-only — edit these with lh issue ac."),
    ).toBeNull();
    // Same box as the issue body, and ahead of the Close action.
    const box = block.parentElement as HTMLElement;
    expect(box.textContent).toContain("Render title, body, labels.");
    expect(
      block.compareDocumentPosition(
        screen.getByRole("button", { name: "Close" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders no acceptance criteria block when the issue has none", async () => {
    renderDetail();

    expect(await screen.findByText("ui2: issue detail")).toBeTruthy();
    expect(screen.queryByText("Acceptance criteria")).toBeNull();
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
    renderDetail(() => noPr, {
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
});
