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
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import type {
  GlobalSettings,
  HerdrSessions,
  Issue,
  LinkedPull,
  PullRequest,
} from "@/api/types";
import { HOVER_POPUP_DELAY_MS } from "@/lib/use-hover-popover";
import { WebConfigProvider } from "@/lib/web-config";

const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));
const settingsData = vi.hoisted(() => ({
  value: {
    agents: {
      "claude-code": { autoModeOnLaunch: false, model: "", effort: "" },
      codex: { autoModeOnLaunch: false, model: "", effort: "" },
      grok: { autoModeOnLaunch: false, model: "", effort: "" },
    },
    codingAgent: "claude-code",
  } as GlobalSettings | undefined,
}));
vi.mock("@/queries/settings", () => ({
  useSettings: () => ({ data: settingsData.value }),
}));
const { focusHerdrAgent, sendHerdrAgentInput } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
  sendHerdrAgentInput: vi.fn(),
}));
const focusHerdrState = vi.hoisted(() => ({ isPending: false }));
const { showError } = vi.hoisted(() => ({ showError: vi.fn() }));
const herdrSessionsData = vi.hoisted(() => ({
  value: undefined as HerdrSessions | undefined,
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({ data: herdrSessionsData.value }),
  useFocusHerdrAgent: () => ({
    mutate: focusHerdrAgent,
    isPending: focusHerdrState.isPending,
  }),
  useSendHerdrAgentInput: () => ({
    mutate: sendHerdrAgentInput,
    isPending: false,
  }),
}));
vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError }),
}));

import { IssueRow, PullRow } from "./dashboard-rows";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  launchTerminal.mockClear();
  focusHerdrAgent.mockClear();
  sendHerdrAgentInput.mockClear();
  showError.mockClear();
  focusHerdrState.isPending = false;
  settingsData.value = {
    agents: {
      "claude-code": { autoModeOnLaunch: false, model: "", effort: "" },
      codex: { autoModeOnLaunch: false, model: "", effort: "" },
      grok: { autoModeOnLaunch: false, model: "", effort: "" },
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
  };
  herdrSessionsData.value = undefined;
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const linkedPulls =
    overrides.linked_pull_requests ??
    (overrides.linked_pull_request ? [overrides.linked_pull_request] : []);
  return {
    number: 1,
    state: "open",
    title: "Example issue",
    body: "",
    target_branch: null,
    user: { login: "me" },
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    has_open_pull_request: linkedPulls.some((pull) => pull.state === "open"),
    ...overrides,
  };
}

// IssueRow renders <Link>, which needs a router context. It also carries the
// Close/Reopen menu (useSetIssueState), which needs a QueryClient context; stub
// fetch so an unmocked "issues/update" call (tests that don't exercise the
// menu) resolves instead of hitting the network.
function renderInRouter(
  ui: React.ReactNode,
  handlers: Record<string, (params: any) => unknown> = {},
) {
  // A linked PR has no workflow run unless a test says otherwise. The generic mock returns `{}`
  // (truthy) for unmapped methods, which would render a bogus WorkflowMiniProgress tracker; the
  // real RPC returns null for a PR with no run.
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({ "workflowRuns/stateForPull": () => null, ...handlers }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <WebConfigProvider config={{ experimental: false }}>
        {ui}
      </WebConfigProvider>
    ),
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function makePull(overrides: Partial<LinkedPull> = {}): LinkedPull {
  return {
    number: 10,
    title: "A PR",
    state: "open",
    merged: false,
    html_url: "/pulls/10",
    github_pull: null,
    cost_stopped: false,
    ...overrides,
  };
}

function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 20,
    state: "open",
    title: "Example PR",
    body: "",
    user: { login: "me" },
    head: { ref: "feature", sha: "head" },
    base: { ref: "main", sha: "base" },
    base_sha: "base",
    merged: false,
    mergeable: null,
    mergeable_state: "blocked",
    merge_commit_sha: null,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    working: false,
    review_state: null,
    review_gate: { reviewed: false, all_topics_passed: false, topics: [] },
    changes_addressed_at: null,
    changes_addressed_by: null,
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    linked_issue: null,
    worktree_path: null,
    cost_stopped: false,
    merge_mode: "merge",
    github_pull: null,
    ...overrides,
  };
}

describe("PullRow", () => {
  it("does not render working while a Herdr agent runs the PR", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 20, pane_id: "w1:p2", status: "working" }],
        },
      ],
    };
    renderInRouter(
      <PullRow
        owner="me"
        repo="proj"
        pull={makePullRequest({
          review_state: "PASSED",
          mergeable_state: "clean",
        })}
      />,
    );

    expect(
      await screen.findByRole("link", { name: /Example PR/ }),
    ).toBeTruthy();
    expect(screen.queryByText("working")).toBeNull();
    expect(screen.getByText("passed")).toBeTruthy();
    expect(screen.getByText("mergeable")).toBeTruthy();
  });
});

describe("IssueRow", () => {
  it("shows the workspace above the issue title", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ target_branch: "feature/foo" })}
      />,
    );
    const row = await screen.findByLabelText("Issue #1: Example issue");
    const workspace = screen.getByText("workspace:feature/foo");
    const title = row.querySelector("[data-issue-row-link]");

    expect(workspace.getAttribute("title")).toBe("Workspace: feature/foo");
    expect(workspace.className).toContain("rounded-md");
    expect(workspace.className).not.toContain("rounded-full");
    expect(workspace.parentElement?.className).toContain("justify-start");
    expect(
      workspace.compareDocumentPosition(title!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not show a workspace when the issue is unassigned", async () => {
    renderInRouter(<IssueRow owner="me" repo="proj" issue={makeIssue()} />);
    await screen.findByText("Example issue");
    expect(screen.queryByText(/^workspace:/)).toBeNull();
  });

  it("shows the issue labels", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          labels: [
            { name: "bug", color: null },
            { name: "ready-to-build", color: null },
          ],
        })}
      />,
    );
    expect(await screen.findByText("bug")).toBeTruthy();
    expect(screen.getByText("ready-to-build")).toBeTruthy();
  });

  it("renders no label chips when there are none", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ labels: [] })} />,
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByText("bug")).toBeNull();
  });

  it("links the title to the issue and the pill to the PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [makePull({ number: 10, working: true })],
        })}
      />,
    );
    const title = await screen.findByRole("link", { name: "Example issue" });
    expect(title.getAttribute("href")).toBe("/r/me/proj/issues/1");
    const pill = screen.getByRole("link", { name: "PR #10" });
    expect(pill.getAttribute("href")).toBe("/r/me/proj/pulls/10");
    // A dirty worktree with no live agent is idle → plain "open" word (#1125).
    expect(screen.getByText("open")).toBeTruthy();
  });

  it("stacks one sub-row per linked PR when there are several", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10, working: true }),
            makePull({ number: 9, merged: true, state: "closed" }),
          ],
        })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #9" })).toBeTruthy();
    // #10 is idle (dirty, no live agent) → "open"; #9 is merged.
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("merged")).toBeTruthy();
  });

  it("dims inactive linked PRs but keeps active linked PRs opaque", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10 }),
            makePull({ number: 9, merged: true, state: "closed" }),
          ],
        })}
      />,
    );

    const activeContent = (
      await screen.findByLabelText("Linked PR #10: A PR")
    ).querySelector("[data-linked-pull-content]");
    const inactiveContent = screen
      .getByLabelText("Linked PR #9: A PR")
      .querySelector("[data-linked-pull-content]");
    expect(activeContent?.className).not.toContain("opacity-45");
    expect(inactiveContent?.className).toContain("opacity-45");
  });

  it("shows a check icon on a passed linked PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10, review_state: "PASSED" }),
          ],
        })}
      />,
    );
    expect(await screen.findByText("passed")).toBeTruthy();
    expect(screen.getByLabelText("passed")).toBeTruthy();
  });

  it("shows no check icon on a non-passed linked PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10, review_state: "CHANGES_REQUESTED" }),
          ],
        })}
      />,
    );
    expect(await screen.findByText("changes")).toBeTruthy();
    expect(screen.queryByLabelText("passed")).toBeNull();
  });

  it("renders a single row (no PR sub-row) when no PR is linked", async () => {
    renderInRouter(<IssueRow owner="me" repo="proj" issue={makeIssue()} />);
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^PR #/ })).toBeNull();
  });

  it("drops the open badge", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ state: "open" })} />,
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByText("open")).toBeNull();
  });

  it("shows the closed badge under the closed filter", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ state: "closed" })}
      />,
    );
    expect(await screen.findByText("closed")).toBeTruthy();
  });

  // The whole-row hover background is removed; keyboard focus keeps its row
  // highlight and focus ring so the row stays reachable and visible.
  it("carries no whole-row hover background but keeps the focus highlight and ring", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    const row = await screen.findByLabelText("Issue #7: Example issue");
    expect(row.className).not.toContain("hover:bg-");
    expect(row.className).toContain("focus:bg-accent");
    expect(row.className).toContain("focus:ring-ring");
  });
});

// #1828: a cost-held run can be given more budget straight from the issue list.
describe("IssueRow workflow budget (#1828)", () => {
  it("increases a held run's budget without leaving the list", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
      {
        "workflowRuns/stateForPull": () => ({
          id: 4,
          workflow_id: 1,
          workflow_name: "standard",
          status: "running",
          current_step: "execute",
          rework_count: 0,
          cost_increment_usd: 10,
          cost_limit_usd: 20,
          cost_limit_increase_available: true,
          needs_human_reason: "Cost limit exceeded",
          issue_number: 1,
          pr_number: 10,
          created_at: "2026-07-17T00:00:00Z",
          updated_at: "2026-07-17T00:00:00Z",
          latest_review: null,
          verification_status: "unverified",
        }),
        "workflowRuns/increaseCostLimit": () => ({
          run: 4,
          increment_usd: 10,
          previous_limit_usd: 20,
          current_limit_usd: 30,
        }),
      },
    );

    const prompt = await screen.findByRole("group", {
      name: "Over budget. Increase to $30.00?",
    });
    const action = within(prompt).getByRole("button", { name: "Yes" });
    await act(async () => {
      fireEvent.click(action);
    });

    expect(rpcCall("workflowRuns/increaseCostLimit")?.params).toMatchObject({
      repo: "me/proj",
      run: 4,
      expected_limit_usd: 20,
    });
  });
});

// #1622: a PR-less issue list row shows a small Start workflow button in the
// linked-PR position, wiring the same terminal/launch flow as issue-detail.
describe("IssueRow Start workflow button (#1622)", () => {
  it("shows the button when the issue has no linked PR", async () => {
    renderInRouter(<IssueRow owner="me" repo="proj" issue={makeIssue()} />, {
      "workflows/list": () => [],
    });
    expect(
      await screen.findByRole("button", { name: /Start workflow/ }),
    ).toBeTruthy();
  });

  it("shows the button when every linked PR is closed", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10, state: "closed" }),
            makePull({ number: 9, state: "closed", merged: true }),
          ],
        })}
      />,
      { "workflows/list": () => [] },
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #9" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start workflow/ })).toBeTruthy();
  });

  it("does not show the button when any linked PR is open", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10, state: "closed" }),
            makePull({ number: 9, state: "open" }),
          ],
        })}
      />,
      { "workflows/list": () => [] },
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #9" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start workflow/ })).toBeNull();
  });

  it("does not show the button on a closed issue with no linked PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ state: "closed" })}
      />,
      { "workflows/list": () => [] },
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start workflow/ })).toBeNull();
  });

  it("launches the chosen workflow when the issue has no linked PR", async () => {
    renderInRouter(<IssueRow owner="me" repo="proj" issue={makeIssue()} />, {
      "workflows/list": () => [
        { id: 7, name: "Dev loop", description: "Build then review" },
      ],
    });
    const button = await screen.findByRole("button", {
      name: /Start workflow/,
    });
    // Radix opens the menu on pointerDown, not a synthetic click.
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Dev loop Build then review",
      }),
    );
    expect(launchTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "me/proj",
        workflow: "workflow-run",
        issueNumber: 1,
        workflowId: 7,
      }),
    );
  });
});

// IssueRow is shared by home Recent issues, repo Open Issues, and /issues, so
// these assertions cover the issue-title popover on all three list surfaces.
describe("IssueRow title popover", () => {
  function issuePopover() {
    return screen.queryByRole("dialog", { name: "Issue #1 details" });
  }

  it("shows the issue basics after the standard hover delay", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          state: "closed",
          body: "A concise issue description.",
          target_branch: "release/1.0",
          user: { login: "octocat" },
          labels: [{ name: "bug", color: null }],
          comments: 2,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T03:04:00Z",
        })}
      />,
    );
    const title = await screen.findByRole("link", { name: "Example issue" });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(title);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS - 1);
    });
    expect(
      screen.queryByRole("dialog", { name: "Issue #1 details" }),
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const popover = screen.getByRole("dialog", {
      name: "Issue #1 details",
    });
    expect(popover.getAttribute("data-debug-component")).toBe("IssuePopover");
    expect(popover.textContent).toContain("#1");
    expect(popover.textContent).toContain("closed");
    expect(popover.textContent).toContain("@octocat");
    expect(popover.textContent).toContain("bug");
    expect(popover.textContent).toContain("2 comments");
    expect(popover.textContent).toContain("release/1.0");
    expect(popover.textContent).toContain("A concise issue description.");
    expect(
      popover.querySelector('time[dateTime="2026-01-01T00:00:00Z"]'),
    ).toBeTruthy();
    expect(
      popover.querySelector('time[dateTime="2026-01-02T03:04:00Z"]'),
    ).toBeTruthy();
  });

  it("opens immediately on focus and closes on Escape or focus leaving", async () => {
    renderInRouter(
      <>
        <IssueRow owner="me" repo="proj" issue={makeIssue()} />
        <button type="button">Outside</button>
      </>,
    );
    const title = await screen.findByRole("link", { name: "Example issue" });

    fireEvent.focus(title);
    expect(issuePopover()).toBeTruthy();

    fireEvent.keyDown(title, { key: "Escape" });
    expect(issuePopover()).toBeNull();

    fireEvent.blur(title);
    fireEvent.focus(title);
    expect(issuePopover()).toBeTruthy();
    const outside = screen.getByRole("button", { name: "Outside" });
    fireEvent.blur(title, { relatedTarget: outside });
    fireEvent.focus(outside);
    expect(issuePopover()).toBeNull();
  });

  it("stays open while the pointer moves from the title into the popover", async () => {
    renderInRouter(<IssueRow owner="me" repo="proj" issue={makeIssue()} />);
    const title = await screen.findByRole("link", { name: "Example issue" });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(title);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    const popover = issuePopover();
    expect(popover).toBeTruthy();

    fireEvent.mouseLeave(title, { relatedTarget: popover });
    fireEvent.mouseEnter(popover!, { relatedTarget: title });
    expect(issuePopover()).toBeTruthy();
  });

  it("shows and focuses the recorded New Issue pane", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          herdr_pane: {
            launch_id: "launch-1",
            pane_id: "w4:p2",
            session_name: "me-proj-12345678",
          },
        })}
      />,
    );
    fireEvent.focus(await screen.findByRole("link", { name: "Example issue" }));

    expect(screen.getByText("me-proj-12345678")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Open in Herdr" });
    fireEvent.click(button);
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w4:p2" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("omits the Herdr action when no New Issue pane ID is recorded", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          herdr_pane: {
            launch_id: "launch-pending",
            pane_id: null,
            session_name: "me-proj-pending",
          },
        })}
      />,
    );
    fireEvent.focus(await screen.findByRole("link", { name: "Example issue" }));

    expect(screen.queryByText("me-proj-pending")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in Herdr" })).toBeNull();
  });

  it("shows the Herdr action as pending while pane focus is processing", async () => {
    focusHerdrState.isPending = true;
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          herdr_pane: {
            launch_id: "launch-1",
            pane_id: "w4:p2",
            session_name: "me-proj-12345678",
          },
        })}
      />,
    );
    fireEvent.focus(await screen.findByRole("link", { name: "Example issue" }));

    const button = screen.getByRole("button", { name: "Open in Herdr" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector(".animate-spin")).toBeTruthy();
  });

  it("reports a pane focus failure through the existing error UI", async () => {
    focusHerdrAgent.mockImplementationOnce((_input, options) => {
      options.onError(new Error("Herdr pane is unavailable"));
    });
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          herdr_pane: {
            launch_id: "launch-1",
            pane_id: "w4:p2",
            session_name: "me-proj-12345678",
          },
        })}
      />,
    );
    fireEvent.focus(await screen.findByRole("link", { name: "Example issue" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in Herdr" }));

    expect(showError).toHaveBeenCalledWith("Herdr pane is unavailable");
  });
});

// #1061: the issue-list overflow menu is removed; issue state actions live on
// the detail page, while the Build button remains for issues without PRs.
describe("IssueRow action menu removal (#1061)", () => {
  it("does not render the row actions menu", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );

    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Issue #7 actions" }),
    ).toBeNull();
    expect(rpcCall("issues/update")).toBeFalsy();
  });
});

// IssueRow is shared by home Recent issues, repo Open Issues, and /issues, so
// these assertions cover the linked-PR interaction on all three list surfaces.
describe("IssueRow linked PR popover trigger (#1289)", () => {
  function popoverHeader(number: number) {
    const links = screen.queryAllByRole("link", { name: `PR #${number}` });
    return links.length === 2 ? links[1] : null;
  }

  function renderPulls(pulls: LinkedPull[]) {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: pulls })}
      />,
    );
  }

  it("does not highlight or schedule a popover from the linked PR row", async () => {
    renderPulls([makePull({ number: 10 })]);
    const row = await screen.findByLabelText("Linked PR #10: A PR");
    expect(row.className).not.toContain("hover:bg-");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(row);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS * 2);
    });
    expect(popoverHeader(10)).toBeNull();
  });

  it("opens after the standard delay only while the PR link is hovered", async () => {
    renderPulls([makePull({ number: 10 })]);
    const link = await screen.findByRole("link", { name: "PR #10" });
    const row = screen.getByLabelText("Linked PR #10: A PR");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(link);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS - 1);
    });
    expect(popoverHeader(10)).toBeNull();

    fireEvent.mouseLeave(link, { relatedTarget: row });
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS * 2);
    });
    expect(popoverHeader(10)).toBeNull();

    fireEvent.mouseEnter(link);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(popoverHeader(10)).toBeTruthy();
  });

  it("keeps the opened popover available while the pointer moves into it", async () => {
    renderPulls([makePull({ number: 10 })]);
    const link = await screen.findByRole("link", { name: "PR #10" });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(link);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    const headerLink = popoverHeader(10);
    const popover = headerLink?.closest<HTMLElement>(".pt-1");
    expect(popover).toBeTruthy();

    fireEvent.mouseLeave(link, { relatedTarget: popover });
    fireEvent.mouseEnter(popover!, { relatedTarget: link });
    expect(popoverHeader(10)).toBeTruthy();
  });

  it("opens only the popover that belongs to the hovered PR link", async () => {
    renderPulls([
      makePull({ number: 10, title: "First PR" }),
      makePull({ number: 9, title: "Second PR" }),
    ]);
    const firstLink = await screen.findByRole("link", { name: "PR #10" });
    const secondLink = screen.getByRole("link", { name: "PR #9" });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(secondLink);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(popoverHeader(9)).toBeTruthy();
    expect(popoverHeader(10)).toBeNull();

    fireEvent.mouseLeave(screen.getByLabelText("Linked PR #9: Second PR"), {
      relatedTarget: document.body,
    });
    fireEvent.mouseEnter(firstLink);
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(popoverHeader(10)).toBeTruthy();
    expect(popoverHeader(9)).toBeNull();
  });
});

// #265: the linked-PR sub-row paints two independent colour axes — the `PR #n`
// pill carries the PR lifecycle (open=primary / merged=purple / closed=grey) and
// the status word its state-specific signal (conflict/changes=red, passed=
// green, the rest muted). These assert the actually-rendered DOM classes.
describe("LinkedPullSubRow two-axis colours (#265)", () => {
  async function renderPull(overrides: Partial<LinkedPull>) {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull(overrides)] })}
      />,
    );
    return await screen.findByRole("link", { name: "PR #10" });
  }

  it("labels an idle open PR (no live agent) with its lifecycle state, dimmed (#1125)", async () => {
    // A dirty/undecided PR with no live agent is idle: it reads its plain "open"
    // lifecycle word (muted, not indigo) and dims the bot icon to the inactive
    // tone instead of pulsing "working".
    await renderPull({ mergeable_state: "blocked", working: true });
    const word = screen.getByText("open");
    expect(word.className).not.toContain("text-indigo-600");
    const bot = screen
      .getByLabelText("Linked PR #10: A PR")
      .querySelector("svg");
    expect(bot?.parentElement?.className).toContain("opacity-45");
    expect(bot?.parentElement?.className).not.toContain(
      "animate-[linked-pull-pulse_2.4s_ease-out_infinite]",
    );
  });

  it("paints a conflict word red", async () => {
    await renderPull({ mergeable_state: "conflict" });
    expect(screen.getByText("conflict").className).toContain(
      "text-destructive",
    );
  });

  it("keeps the bot working effect while an agent resolves a conflict", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
        },
      ],
    };
    await renderPull({ mergeable_state: "conflict" });

    expect(screen.getByText("conflict")).toBeTruthy();
    const bot = screen
      .getByLabelText("Linked PR #10: A PR")
      .querySelector("svg");
    expect(bot?.parentElement?.className).toContain(
      "animate-[linked-pull-pulse_2.4s_ease-out_infinite]",
    );
  });

  it("does not show the working effect on a merged PR with a stale agent signal", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
        },
      ],
    };
    await renderPull({ state: "closed", merged: true });

    expect(screen.getByText("merged")).toBeTruthy();
    const bot = screen
      .getByLabelText("Linked PR #10: A PR")
      .querySelector("svg");
    expect(bot?.parentElement?.className).not.toContain(
      "animate-[linked-pull-pulse_2.4s_ease-out_infinite]",
    );
  });

  it("paints a changes word red", async () => {
    await renderPull({ review_state: "CHANGES_REQUESTED" });
    expect(screen.getByText("changes").className).toContain("text-destructive");
  });

  it("paints a passed word green", async () => {
    await renderPull({
      review_state: "PASSED",
      mergeable_state: "clean",
    });
    expect(screen.getByText("passed").className).toContain("text-green-600");
  });

  it("keeps review results and omits working while Herdr reports the PR working", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
        },
      ],
    };
    await renderPull({
      review_state: "CHANGES_REQUESTED",
      mergeable_state: "clean",
    });
    expect(screen.getByText("changes")).toBeTruthy();
    expect(screen.queryByText("working")).toBeNull();
  });

  it("uses agent status when multiple agents target the PR", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [
            {
              id: "agent-1",
              name: "blocked-agent",
              status: "blocked",
              pull: 10,
            },
            {
              id: "agent-2",
              name: "working-agent",
              status: "working",
              pull: 10,
            },
          ],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "blocked" }],
        },
      ],
    };
    await renderPull({
      review_state: "CHANGES_REQUESTED",
      mergeable_state: "clean",
    });
    expect(screen.getByText("changes")).toBeTruthy();
    expect(screen.queryByText("working")).toBeNull();
  });

  it("does not suppress review results for a blocked herdr agent", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "blocked" }],
        },
      ],
    };
    await renderPull({
      review_state: "PASSED",
      mergeable_state: "clean",
    });
    expect(screen.getByText("passed")).toBeTruthy();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(screen.getByRole("link", { name: "PR #10" }));
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(screen.getByText("Herdr").nextSibling?.textContent).toBe("blocked");
    expect(
      screen
        .getByLabelText("Linked PR #10: A PR")
        .querySelector(".bg-destructive"),
    ).toBeTruthy();
  });

  it("keeps re-review and working words muted", async () => {
    await renderPull({ review_state: "STALE" });
    expect(screen.getByText("re-review").className).toContain(
      "text-muted-foreground",
    );
  });

  it("colours a merged word violet", async () => {
    await renderPull({ merged: true, state: "closed" });
    expect(screen.getByText("merged").className).toContain("text-violet-500");
  });
});

// #1061: Herdr focus moved from an always-visible badge into the linked-PR
// hover popover. #1493: the single popover button became the per-pane terminal
// icon in the shared Agents list, so the popover only offers an "Open in Herdr"
// action when a live pane resolves to this PR.
describe("linked PR Herdr popover action (#1061)", () => {
  // The popover now opens after a standard hover delay, so advance fake timers
  // past it before asserting the popover contents.
  function openPopover() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(screen.getByRole("link", { name: "PR #10" }));
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
  }

  // A live pane resolving to PR #10, plus its derived workspace entry — the
  // realistic pairing (pull_workspaces is derived from the same agent list).
  function herdrWithPullAgent(
    agent: Partial<HerdrSessions["repos"][number]["agents"][number]> = {},
    repo = "me/proj",
  ): HerdrSessions {
    return {
      repos: [
        {
          repo,
          session_name: "me-proj-abc",
          agents: [
            {
              id: "w1:p2",
              name: "dev #10",
              status: "working",
              pull: 10,
              pull_closed: false,
              focusable: true,
              ...agent,
            },
          ],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
          issue_workspaces: [],
        },
      ],
    };
  }

  it("does not render Open in Herdr until the linked PR link is hovered", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in Herdr" })).toBeNull();
  });

  it("shows no badge when no PR is linked, even if herdr sessions are running elsewhere", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
        },
      ],
    };
    renderInRouter(<IssueRow owner="me" repo="proj" issue={makeIssue()} />);
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in Herdr" })).toBeNull();
  });

  it("shows an enabled Open in Herdr action when a live pane resolves to the PR", async () => {
    herdrSessionsData.value = herdrWithPullAgent();
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    openPopover();
    expect(
      screen.getByRole("button", { name: "Open in Herdr" }).closest(".pt-1"),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Open in Herdr",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("renders the popover with an opaque theme background", async () => {
    herdrSessionsData.value = herdrWithPullAgent();
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    openPopover();

    const popover = screen
      .getByRole("button", { name: "Open in Herdr" })
      .closest(".pt-1")?.firstElementChild;
    expect(popover?.className).toContain("bg-background");
    expect(popover?.className).toContain("text-foreground");
  });

  it("uses the Herdr working signal only for the activity effect", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
        },
      ],
    };
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByText("open")).toBeTruthy();
    expect(screen.queryByText("working")).toBeNull();
    openPopover();
    expect(screen.queryByText("working")).toBeNull();
    const bot = screen
      .getByLabelText("Linked PR #10: A PR")
      .querySelector("svg");
    expect(bot?.parentElement?.className).toContain("dark:bg-sky-950");
    expect(bot?.parentElement?.className).toContain(
      "animate-[linked-pull-pulse_2.4s_ease-out_infinite]",
    );
  });

  it("offers no Open in Herdr action for a pane running a different PR", async () => {
    herdrSessionsData.value = herdrWithPullAgent({ pull: 99, name: "dev #99" });
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    openPopover();
    expect(screen.queryByRole("button", { name: "Open in Herdr" })).toBeNull();
  });

  it("offers no Open in Herdr action for a pane running in a different repo", async () => {
    herdrSessionsData.value = herdrWithPullAgent({}, "me/other");
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    openPopover();
    expect(screen.queryByRole("button", { name: "Open in Herdr" })).toBeNull();
  });

  it("focuses the agent's pane from the popover Agents list", async () => {
    herdrSessionsData.value = herdrWithPullAgent();
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    openPopover();
    fireEvent.click(screen.getByRole("button", { name: "Open in Herdr" }));
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p2" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });
});

// #783: agent cost (short token count + cost) on the linked-PR sub-row. Rendered by
// `LinkedPullSubRow`, the single component shared by the home dashboard, the repo dashboard, and the
// dedicated issue-list screen — so this covers the display requirement identically for all three.
describe("agent cost display (#783)", () => {
  it("shows the short token count and cost when the PR has usage", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ total_tokens: 12345, cost_usd: 4.5 }),
          ],
        })}
      />,
    );
    expect(await screen.findByTitle("12.3k · $5")).toBeTruthy();
  });

  it("omits cost when the PR's usage has an unknown cost", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ total_tokens: 500, cost_usd: null }),
          ],
        })}
      />,
    );
    expect(await screen.findByText("500")).toBeTruthy();
    expect(screen.queryByText(/n\/a/)).toBeNull();
  });

  it("shows nothing when the PR has no linked session usage yet", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull()] })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    expect(screen.queryByText(/\d+(?:\.\d+)?[kMB]? · \$/)).toBeNull();
  });

  it("rounds cost to whole dollars", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ total_tokens: 1000, cost_usd: 10 }),
          ],
        })}
      />,
    );
    expect(await screen.findByTitle("1k · $10")).toBeTruthy();
  });

  it("uses the existing over-budget state to highlight only the cost", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({
              total_tokens: 1000,
              cost_usd: 10.01,
              cost_stopped: true,
            }),
          ],
        })}
      />,
    );
    const row = await screen.findByLabelText("Linked PR #10: A PR");
    const cost = row.querySelector<HTMLElement>("[data-linked-pull-cost]");
    expect(cost?.textContent).toBe("$10");
    expect(cost?.className).toContain("text-amber-700");
    expect(cost?.className).toContain("dark:text-amber-300");
    expect(screen.getByText("1k").className).not.toContain("text-amber");
  });

  it("keeps a non-over-budget cost muted regardless of its amount", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({
              total_tokens: 1000,
              cost_usd: 30.01,
              cost_stopped: false,
            }),
          ],
        })}
      />,
    );
    const row = await screen.findByLabelText("Linked PR #10: A PR");
    const cost = row.querySelector<HTMLElement>("[data-linked-pull-cost]");
    expect(cost?.textContent).toBe("$30");
    expect(cost?.className).toContain("text-muted-foreground/70");
    expect(cost?.className).not.toContain("text-amber");
  });
});

// #863: a PR force-stopped for exceeding its cost limit gets an "over budget" badge on the
// issue-list linked-PR sub-row (LinkedPullSubRow), so a stalled PR is spotted at a glance.
describe("cost-stopped badge on the linked-PR sub-row (#863)", () => {
  it("shows the badge on a stopped PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [makePull({ cost_stopped: true })],
        })}
      />,
    );
    const badge = await screen.findByText(/over budget/);
    expect(badge.className).toContain("text-amber-700");
  });

  it("keeps the bot icon bright on a stopped PR — it needs a human, not idle (#1125)", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [makePull({ cost_stopped: true })],
        })}
      />,
    );
    await screen.findByText(/over budget/);
    const bot = screen
      .getByLabelText("Linked PR #10: A PR")
      .querySelector("svg");
    expect(bot?.parentElement?.className).not.toContain("opacity-45");
  });

  it("does not show the badge on a PR that was never stopped", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [makePull({ cost_stopped: false })],
        })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    expect(screen.queryByText(/over budget/)).toBeNull();
  });
});

// #842: the linked-PR sub-row shows the agent runtime/model as compact metadata between the
// status word and usage/cost. IssueRow is shared by home, repo dashboard, and the dedicated list.
describe("linked PR agent metadata (#842)", () => {
  it("separates linked PR sub-row elements with middle dots", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
        },
      ],
    };
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({
              mergeable_state: "blocked",
              agent_runtime: "claude-code",
              agent_model: "opus",
              github_pull: {
                number: 99,
                url: "https://github.com/me/proj/pull/99",
                branch: null,
                created_by: null,
                created_at: "2026-01-01T00:00:00Z",
                github_merged: false,
                github_merged_at: null,
                pushed_sha: null,
              },
              total_tokens: 12345,
              cost_usd: 4.5,
            }),
          ],
        })}
      />,
    );

    const metadata = await screen.findByText("Claude Code · opus");
    expect(metadata.className).toContain("truncate");
    const rowText = metadata.closest("div")?.textContent ?? "";
    expect(rowText).toBe("Claude Code · opus·PR #10GH #99open12.3k · $5");
  });

  it("shows only the known half and stays quiet when both are unknown", async () => {
    renderInRouter(
      <div>
        <IssueRow
          owner="me"
          repo="proj"
          issue={makeIssue({
            number: 1,
            linked_pull_requests: [
              makePull({ number: 10, agent_runtime: "codex" }),
            ],
          })}
        />
        <IssueRow
          owner="me"
          repo="proj"
          issue={makeIssue({
            number: 2,
            linked_pull_requests: [makePull({ number: 11 })],
          })}
        />
      </div>,
    );

    expect(await screen.findByText("Codex")).toBeTruthy();
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });
});
