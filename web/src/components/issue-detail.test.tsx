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
import type { Issue, IssueComment, IssueGroupWithMembers } from "@/api/types";
import { ACTION_LOADING_MS } from "@/lib/use-fixed-loading";

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
  user: { login: "me" },
  labels: [{ name: "ready-to-build" }],
  comments: 1,
  created_at: "2026-06-17T11:00:00Z",
  updated_at: "2026-06-17T12:00:00Z",
  linked_pull_request: {
    number: 30,
    title: "ui2: issue detail PR",
    state: "open",
    merged: false,
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
  getGroups: () => IssueGroupWithMembers[] = () => [],
  autoModeOnBuild = false,
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  return mockRpcFetch({
    ...extraHandlers,
    "issues/get": getIssue,
    "issueGroups/forIssue": getGroups,
    "comments/list": () => comments,
    "comments/create": (p) => ({
      id: 2,
      user: { login: "me" },
      body: p.body,
      created_at: "2026-06-17T12:30:00Z",
    }),
    "settings/get": () => ({
      agents: {
        "claude-code": { autoModeOnBuild },
        codex: { autoModeOnBuild: false },
      },
      codingAgent: "claude-code",
    }),
  });
}

function renderDetail(
  getIssue?: () => Issue,
  getGroups?: () => IssueGroupWithMembers[],
  autoModeOnBuild = false,
  extraHandlers: Record<string, (params: any) => unknown> = {},
) {
  vi.stubGlobal(
    "fetch",
    mockFetch(getIssue, getGroups, autoModeOnBuild, extraHandlers),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <IssueDetail owner="me" repo="proj" number={12} />,
  });
  // The linked-PR link targets the pulls route; register it for the router.
  const pullsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  // The grouped-issues list (IssueRow) links to the issues route; register it too.
  const issuesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, pullsRoute, issuesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("IssueDetail", () => {
  it("renders title, body, labels, comments, and the linked PR summary", async () => {
    renderDetail();

    expect(await screen.findByText("ui2: issue detail")).toBeTruthy();
    expect(screen.getByText("Render title, body, labels.")).toBeTruthy();
    expect(screen.getByText("ready-to-build")).toBeTruthy();
    expect(screen.getByText("Looks good.")).toBeTruthy();

    // The linked-PR summary card: a `PR #n` pill, the state word, and the title,
    // all linking to the PR detail route.
    const pill = screen.getByText("PR #30").closest("a");
    expect(pill?.getAttribute("href")).toBe("/r/me/proj/pulls/30");
    const titleLink = screen.getByText("ui2: issue detail PR").closest("a");
    expect(titleLink?.getAttribute("href")).toBe("/r/me/proj/pulls/30");
    // The state word ("open") shows inside the same summary card.
    expect(pill?.closest("div")?.textContent).toContain("open");
  });

  it("shows linked PR summary as working while a herdr terminal is working", async () => {
    renderDetail(
      () => ({
        ...issue,
        linked_pull_request: {
          ...issue.linked_pull_request!,
          review_state: "CHANGES_REQUESTED",
        },
      }),
      undefined,
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
    const workingBadge = ctx.getByTitle(
      "Herdr agent is working in the PR worktree",
    );
    expect(workingBadge.textContent).toBe("working");
    expect(ctx.queryByText("changes")).toBeNull();
  });

  it("hides the linked-PR summary when no PR is linked", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    await screen.findByText("ui2: issue detail");
    expect(screen.queryByText(/^PR #/)).toBeNull();
  });

  it("shows the New Issue Herdr pane focus button when a pane is linked", async () => {
    renderDetail(
      () => ({
        ...issue,
        herdr_pane: {
          launch_id: "launch-1",
          pane_id: "w4:p2",
          session_name: "me-proj-12345678",
        },
      }),
      undefined,
      false,
      {
        "terminal/focusAgent": () => ({ ok: true }),
      },
    );

    const button = await screen.findByRole("button", {
      name: "Focus Herdr terminal for issue #12",
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(rpcCall("terminal/focusAgent")?.params).toEqual({
        repo: "me/proj",
        paneId: "w4:p2",
      });
    });
  });

  it("hides the New Issue Herdr pane focus button when no pane is linked", async () => {
    renderDetail(() => ({ ...issue, herdr_pane: null }));

    await screen.findByText("ui2: issue detail");
    expect(
      screen.queryByRole("button", {
        name: "Focus Herdr terminal for issue #12",
      }),
    ).toBeNull();
  });

  it("renders every linked PR from the detail response array", async () => {
    const multiPr: Issue = {
      ...issue,
      linked_pull_request: {
        number: 31,
        title: "current attempt",
        state: "open",
        merged: false,
      },
      linked_pull_requests: [
        {
          number: 31,
          title: "current attempt",
          state: "open",
          merged: false,
        },
        {
          number: 30,
          title: "merged attempt",
          state: "closed",
          merged: true,
        },
        {
          number: 29,
          title: "closed attempt",
          state: "closed",
          merged: false,
        },
      ],
    };
    renderDetail(() => multiPr);

    expect(await screen.findByText("Linked pull requests")).toBeTruthy();
    expect(screen.getByText("PR #31")).toBeTruthy();
    expect(screen.getByText("current attempt")).toBeTruthy();
    expect(screen.getByText("PR #30")).toBeTruthy();
    expect(screen.getByText("merged attempt")).toBeTruthy();
    expect(screen.getByText("PR #29")).toBeTruthy();
    expect(screen.getByText("closed attempt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
  });

  // #609: the linked-PR row shows the same Herdr badge as the issue list, shown only while
  // herdr reports an agent running in that PR's worktree; clicking focuses its pane.
  it("shows the Herdr badge on the linked-PR row and focuses on click", async () => {
    renderDetail(undefined, undefined, false, {
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

    const badge = await screen.findByRole("button", {
      name: "Focus Herdr terminal for PR #30",
    });
    expect(
      badge.querySelector("svg")?.classList.contains("animate-bot-wobble"),
    ).toBe(true);
    fireEvent.click(badge);
    await waitFor(() => {
      expect(rpcCall("terminal/focusAgent")?.params).toEqual({
        repo: "me/proj",
        paneId: "%7",
      });
    });
  });

  it("adds a bounce animation for blocked Herdr workspace status", async () => {
    renderDetail(undefined, undefined, false, {
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

    const badge = await screen.findByRole("button", {
      name: "Focus Herdr terminal for PR #30",
    });
    expect(
      badge.querySelector("svg")?.classList.contains("animate-bot-bounce"),
    ).toBe(true);
  });

  it("shows no Herdr badge on the linked-PR row when no herdr session runs the PR", async () => {
    renderDetail(undefined, undefined, false, {
      "terminal/sessions": () => ({ repos: [] }),
    });

    expect(await screen.findByText("PR #30")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Focus Herdr terminal/ }),
    ).toBeNull();
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

    // Close renders, so the header is mounted — Build must be absent.
    await screen.findByRole("button", { name: /close/i });
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
    expect(screen.getByText("Building")).toBeTruthy();
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
  });

  it("shows the Build button when no PR is linked", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    expect(await screen.findByRole("button", { name: /^Build$/ })).toBeTruthy();
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

  it("launches `lh dev <n> --herdr` in a terminal when the Build button is clicked", async () => {
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

  it("shows the --auto command in the title when auto-mode-on-Build is enabled", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr, undefined, true);

    const button = await screen.findByRole("button", { name: /^Build$/ });

    expect(button.title).toBe("Start `lh dev 12 --herdr --auto` in a terminal");
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

  it("lists other issues in the same group, excluding the current one", async () => {
    const member = (number: number, title: string): Issue => ({
      ...issue,
      number,
      title,
      linked_pull_request: null,
    });
    const groups: IssueGroupWithMembers[] = [
      {
        group: {
          id: 1,
          name: "sprint-1",
          members: 3,
          created_at: "2026-06-17T10:00:00Z",
          updated_at: "2026-06-17T10:00:00Z",
        },
        // Includes the current issue (#12); the UI must drop it.
        members: [
          member(12, "self"),
          member(13, "next-a"),
          member(14, "next-b"),
        ],
      },
    ];
    renderDetail(undefined, () => groups);

    expect(await screen.findByText("next-a")).toBeTruthy();
    const otherLink = screen.getByText("next-a").closest("a");
    expect(otherLink?.getAttribute("href")).toBe("/r/me/proj/issues/13");
    // The group heading reports the count of *other* members (2, not 3).
    expect(screen.getByText(/Group: sprint-1/)).toBeTruthy();
    expect(screen.getByText(/2 others/)).toBeTruthy();
    // The current issue's title appears once (the header), not duplicated in the group list.
    expect(screen.getAllByText("ui2: issue detail").length).toBe(1);
  });

  it("renders no group section when the issue belongs to no group", async () => {
    renderDetail(undefined, () => []);

    await screen.findByText("ui2: issue detail");
    expect(screen.queryByText(/^Group:/)).toBeNull();
  });
});
