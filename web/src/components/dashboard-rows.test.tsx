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
import { ACTION_LOADING_MS } from "@/lib/use-fixed-loading";

const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));
const settingsData = vi.hoisted(() => ({
  value: {
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "", effort: "" },
      codex: { autoModeOnBuild: false, model: "", effort: "" },
    },
    codingAgent: "claude-code",
  } as GlobalSettings | undefined,
}));
vi.mock("@/queries/settings", () => ({
  useSettings: () => ({ data: settingsData.value }),
}));
const { focusHerdrAgent } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
}));
const herdrSessionsData = vi.hoisted(() => ({
  value: undefined as HerdrSessions | undefined,
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({ data: herdrSessionsData.value }),
  useFocusHerdrAgent: () => ({
    mutate: focusHerdrAgent,
    isPending: false,
  }),
}));

import { IssueRow, PullRow } from "./dashboard-rows";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  launchTerminal.mockClear();
  focusHerdrAgent.mockClear();
  settingsData.value = {
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "", effort: "" },
      codex: { autoModeOnBuild: false, model: "", effort: "" },
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
  };
  herdrSessionsData.value = undefined;
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
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
  vi.stubGlobal("fetch", mockRpcFetch(handlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
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
    merged: false,
    draft: false,
    mergeable: null,
    mergeable_state: "blocked",
    merge_commit_sha: null,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    working: false,
    review_state: null,
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
  it("renders herdr working status without crashing", async () => {
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
    renderInRouter(<PullRow owner="me" repo="proj" pull={makePullRequest()} />);

    expect(
      await screen.findByRole("link", { name: /Example PR/ }),
    ).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
  });
});

describe("IssueRow", () => {
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
    expect(screen.getByText("working")).toBeTruthy();
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
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("merged")).toBeTruthy();
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

  // The Build button mirrors the issue-detail Build trigger: visible unless a
  // linked PR is actively in progress (open) or already merged (done).
  it("shows the Build button when no PR is linked", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    expect(
      await screen.findByRole("button", { name: "Build issue #7" }),
    ).toBeTruthy();
  });

  it("renders the Build button always visible (not hover-revealed)", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    const button = await screen.findByRole("button", {
      name: "Build issue #7",
    });
    // No opacity-0 / hover-reveal classes: the button must show without hover so
    // a label row's layout does not shift on the button appearing/disappearing.
    expect(button.className).not.toContain("opacity-0");
    expect(button.className).not.toContain("group-hover:opacity-100");
  });

  it("launches the typed issue-dev workflow when the Build button is clicked", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    const button = await screen.findByRole("button", {
      name: "Build issue #7",
    });

    fireEvent.click(button);

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: "Issue #7 - Example issue",
      workflow: "issue-dev",
      issueNumber: 7,
    });
  });

  it("shows the --auto command in the title when auto-mode-on-Build is enabled", async () => {
    settingsData.value = {
      agents: {
        "claude-code": { autoModeOnBuild: true, model: "", effort: "" },
        codex: { autoModeOnBuild: false, model: "", effort: "" },
      },
      codingAgent: "claude-code",
      devCostLimitUsd: 10,
    };
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    const button = await screen.findByRole("button", {
      name: "Build issue #7",
    });

    expect(button.title).toBe(
      "Start `lh build 7 --herdr --auto` in a terminal",
    );
  });

  it("shows a fixed-duration loading state on the Build button and re-enables it after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    const button = await screen.findByRole("button", {
      name: "Build issue #7",
    });

    fireEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTION_LOADING_MS);
    });
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
  });

  it("shows the Build button when the linked PR is closed unmerged (rejected)", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          number: 7,
          linked_pull_requests: [makePull({ state: "closed", merged: false })],
        })}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Build issue #7" }),
    ).toBeTruthy();
  });

  it("hides the Build button while a linked PR is open", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          number: 7,
          linked_pull_requests: [makePull({ state: "open", merged: false })],
        })}
      />,
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build issue #7" })).toBeNull();
  });

  it("hides the Build button once a linked PR is merged", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          number: 7,
          linked_pull_requests: [makePull({ state: "closed", merged: true })],
        })}
      />,
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build issue #7" })).toBeNull();
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

  it("labels a fresh open PR (no review/conflict, status computed) as working", async () => {
    // Previously fell to null → bare pill. Now reads working (muted word).
    await renderPull({ mergeable_state: "blocked" });
    const word = screen.getByText("working");
    expect(word.className).toContain("text-indigo-600");
  });

  it("paints a conflict word red", async () => {
    await renderPull({ mergeable_state: "conflict" });
    expect(screen.getByText("conflict").className).toContain(
      "text-destructive",
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

  it("shows working instead of review results while herdr reports the PR working", async () => {
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
    expect(screen.queryByText("changes")).toBeNull();
    expect(screen.getAllByText("working").length).toBeGreaterThan(0);
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
    expect(screen.queryByText("changes")).toBeNull();
    expect(screen.getByText("working")).toBeTruthy();
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
    fireEvent.mouseEnter(screen.getByLabelText("Linked PR #10: A PR"));
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
// hover popover.
describe("linked PR Herdr popover action (#1061)", () => {
  function openPopover() {
    fireEvent.mouseEnter(screen.getByLabelText("Linked PR #10: A PR"));
  }

  it("does not render Open in Herdr until the linked PR row is hovered", async () => {
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

  it("shows an enabled Open in Herdr action when herdr reports the PR workspace", async () => {
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

  it("uses the herdr working signal for the status word", async () => {
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
    expect(await screen.findByText("working")).toBeTruthy();
    const bot = screen
      .getByLabelText("Linked PR #10: A PR")
      .querySelector("svg");
    expect(bot?.parentElement?.className).toContain("dark:bg-sky-950");
    expect(bot?.parentElement?.className).toContain(
      "animate-[linked-pull-pulse_2.4s_ease-out_infinite]",
    );
  });

  it("does not show the badge for an agent running a different PR", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 99, pane_id: "w1:p2", status: "working" }],
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
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    openPopover();
    expect(
      (
        screen.getByRole("button", {
          name: "Open in Herdr",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("does not show the badge for an agent running in a different repo", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/other",
          session_name: "me-other-abc",
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
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    openPopover();
    expect(
      (
        screen.getByRole("button", {
          name: "Open in Herdr",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("focuses the agent's pane from the popover action", async () => {
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
    expect(await screen.findByText("12.3k · $5")).toBeTruthy();
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
    expect(await screen.findByText("1k · $10")).toBeTruthy();
  });

  it("keeps warning and critical cost totals as muted metadata", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ total_tokens: 1000, cost_usd: 10.01 }),
          ],
        })}
      />,
    );
    const warning = await screen.findByText("1k · $10");
    expect(warning.className).toContain("text-muted-foreground/70");
    expect(warning.className).not.toContain("text-amber-600");

    cleanup();
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ total_tokens: 1000, cost_usd: 30.01 }),
          ],
        })}
      />,
    );
    const critical = await screen.findByText("1k · $30");
    expect(critical.className).toContain("text-muted-foreground/70");
    expect(critical.className).not.toContain("text-destructive");
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
    expect(rowText).toBe("Claude Code · opus·PR #10GH #99working12.3k · $5");
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
