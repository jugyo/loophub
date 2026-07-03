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
import type { HerdrSessions, Issue, LinkedPull } from "@/api/types";
import { ACTION_LOADING_MS } from "@/lib/use-fixed-loading";

const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));
const settingsData = vi.hoisted(() => ({
  value: { autoModeOnBuild: false } as { autoModeOnBuild: boolean } | undefined,
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
  settingsData.value = { autoModeOnBuild: false };
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
          labels: [{ name: "bug" }, { name: "ready-to-build" }],
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
    settingsData.value = { autoModeOnBuild: true };
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
    return screen.queryByRole("button", { name: /Focus Herdr terminal/ });
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
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2" }],
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
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2" }],
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
    expect(await screen.findByText("Herdr")).toBeTruthy();
  });

  it("does not show the badge for an agent running a different PR", async () => {
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [],
          pull_workspaces: [{ pull: 99, pane_id: "w1:p2" }],
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
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2" }],
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
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2" }],
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
      name: "Focus Herdr terminal for PR #10",
    });
    fireEvent.click(badge);
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p2" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });
});
