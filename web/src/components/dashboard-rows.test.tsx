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
import type {
  GlobalSettings,
  HerdrSessions,
  Issue,
  LinkedPull,
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

import { IssueRow } from "./dashboard-rows";

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
  };
  herdrSessionsData.value = undefined;
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    state: "open",
    title: "Example issue",
    body: "",
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
    };
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    const button = await screen.findByRole("button", {
      name: "Build issue #7",
    });

    expect(button.title).toBe("Start `lh dev 7 --herdr --auto` in a terminal");
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

// #582: an overflow (⋮) menu at the row's right end offers Close/Reopen,
// reusing the same toggle mutation as the issue-detail button.
describe("IssueRow overflow menu (#582)", () => {
  it("shows a Close action for an open issue and closes it", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
      { "issues/update": (p) => ({ ...makeIssue({ number: 7 }), ...p }) },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Issue #7 actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));

    await waitFor(() => expect(rpcCall("issues/update")).toBeTruthy());
    expect(rpcCall("issues/update")!.params.state).toBe("closed");
  });

  it("shows a Reopen action for a closed issue", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ number: 7, state: "closed" })}
      />,
      { "issues/update": (p) => ({ ...makeIssue({ number: 7 }), ...p }) },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Issue #7 actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reopen" }));

    await waitFor(() => expect(rpcCall("issues/update")).toBeTruthy());
    expect(rpcCall("issues/update")!.params.state).toBe("open");
  });

  it("closes the menu on outside click without triggering the action", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Issue #7 actions" }),
    );
    expect(screen.getByRole("menuitem", { name: "Close" })).toBeTruthy();

    fireEvent.mouseDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Close" })).toBeNull(),
    );
    expect(rpcCall("issues/update")).toBeFalsy();
  });
});

// #265: the linked-PR sub-row paints two independent colour axes — the `PR #n`
// pill carries the PR lifecycle (open=green / merged=purple / closed=grey) and
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
    const pill = await renderPull({ mergeable_state: "blocked" });
    expect(pill.className).toContain("text-green-600"); // open pill = green
    const word = screen.getByText("working");
    expect(word.className).toContain("text-muted-foreground");
  });

  it("paints a conflict word red while the pill stays green (open)", async () => {
    const pill = await renderPull({ mergeable_state: "conflict" });
    expect(pill.className).toContain("text-green-600"); // lifecycle: open
    expect(screen.getByText("conflict").className).toContain(
      "text-destructive",
    );
  });

  it("paints a changes word red", async () => {
    await renderPull({ review_state: "CHANGES_REQUESTED" });
    expect(screen.getByText("changes").className).toContain("text-destructive");
  });

  it("paints a passed word green on a green pill", async () => {
    const pill = await renderPull({
      review_state: "PASSED",
      mergeable_state: "clean",
    });
    expect(pill.className).toContain("text-green-600");
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
  });

  it("keeps re-review and working words muted", async () => {
    await renderPull({ review_state: "STALE" });
    expect(screen.getByText("re-review").className).toContain(
      "text-muted-foreground",
    );
  });

  it("colours a merged pill and word purple", async () => {
    const pill = await renderPull({ merged: true, state: "closed" });
    expect(pill.className).toContain("text-purple-500");
    expect(screen.getByText("merged").className).toContain("text-purple-500");
  });
});

// #579: a terminal-icon badge on the linked-PR sub-row, shown only while herdr reports an
// agent running in that PR's worktree, and clicking it switches herdr's focus there.
describe("Herdr running badge (#579)", () => {
  function badgeQuery() {
    return screen.queryByRole("button", { name: /Focus terminal/ });
  }

  it("shows no badge when no herdr session is running for the PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    expect(badgeQuery()).toBeNull();
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
    expect(badgeQuery()).toBeNull();
  });

  it("shows the badge when herdr reports a running agent for the issue's PR", async () => {
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
    const badge = await screen.findByRole("button", {
      name: /Focus terminal/,
    });
    expect(badge).toBeTruthy();
    expect(within(badge).getByText("working")).toBeTruthy();
  });

  it("shows the raw herdr status string alongside the badge, unchanged (#596)", async () => {
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
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ linked_pull_requests: [makePull({ number: 10 })] })}
      />,
    );
    expect(await screen.findByText("blocked")).toBeTruthy();
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
    expect(badgeQuery()).toBeNull();
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
    expect(badgeQuery()).toBeNull();
  });

  it("focuses the agent's pane when the badge is clicked", async () => {
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
    const badge = await screen.findByRole("button", {
      name: "Focus terminal for PR #10",
    });
    fireEvent.click(badge);
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
    expect(await screen.findByText("12.3k tok · $4.50")).toBeTruthy();
  });

  it("shows n/a for cost when the PR's usage has an unknown cost", async () => {
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
    expect(await screen.findByText("500 tok · n/a")).toBeTruthy();
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
    expect(screen.queryByText(/tok ·/)).toBeNull();
  });

  // #796: two-stage highlight above the cost thresholds ($10 warning, $30 critical), tuned from the
  // observed past-PR cost distribution (p75 ≈ $10, p95 ≈ $27).
  it("shows the default (unhighlighted) style at or below the warning threshold", async () => {
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
    const badge = await screen.findByText("1k tok · $10.00");
    expect(badge.className).not.toContain("text-amber");
    expect(badge.className).not.toContain("text-destructive");
  });

  it("highlights warning (amber) above $10 up to $30", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ total_tokens: 1000, cost_usd: 15 }),
          ],
        })}
      />,
    );
    const badge = await screen.findByText("1k tok · $15.00");
    expect(badge.className).toContain("text-amber-600");
  });

  it("highlights critical (destructive) above $30", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ total_tokens: 1000, cost_usd: 35 }),
          ],
        })}
      />,
    );
    const badge = await screen.findByText("1k tok · $35.00");
    expect(badge.className).toContain("text-destructive");
  });

  it("does not highlight when cost is unknown (null)", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ total_tokens: 1000, cost_usd: null }),
          ],
        })}
      />,
    );
    const badge = await screen.findByText("1k tok · n/a");
    expect(badge.className).not.toContain("text-amber");
    expect(badge.className).not.toContain("text-destructive");
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
    expect(await screen.findByText("over budget")).toBeTruthy();
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
    expect(screen.queryByText("over budget")).toBeNull();
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
              },
              total_tokens: 12345,
              cost_usd: 4.5,
            }),
          ],
        })}
      />,
    );

    const metadata = await screen.findByText("Claude Code · opus");
    expect(metadata.className).toContain("text-muted-foreground");
    const rowText = metadata.closest("div")?.textContent ?? "";
    expect(rowText).toBe(
      "PR #10·GH #99·working·Claude Code · opus·12.3k tok · $4.50·working",
    );
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
