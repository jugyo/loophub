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
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { HerdrSessions, LinkedPull, WorkflowRunState } from "@/api/types";
import { HOVER_POPUP_DELAY_MS } from "@/lib/use-hover-popover";

const { focusHerdrAgent, showError } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
  showError: vi.fn(),
}));
const herdrSessionsData = vi.hoisted(() => ({
  value: undefined as HerdrSessions | undefined,
  isError: false,
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({
    data: herdrSessionsData.value,
    isError: herdrSessionsData.isError,
  }),
  useFocusHerdrAgent: () => ({ mutate: focusHerdrAgent, isPending: false }),
}));
vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError }),
}));

import { LinkedPullSummaryRow } from "./linked-pull-summary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  focusHerdrAgent.mockClear();
  showError.mockClear();
  herdrSessionsData.value = undefined;
  herdrSessionsData.isError = false;
});

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

function renderRow() {
  vi.stubGlobal("fetch", mockRpcFetch({}));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <LinkedPullSummaryRow owner="me" repo="proj" pull={makePull()} />
    ),
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => <div>PR detail</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function row() {
  return screen.getByLabelText("Linked PR #10: A PR");
}

function popoverVisible() {
  return screen.queryAllByRole("link", { name: "PR #10" }).length === 2;
}

function herdrWithOrchestrator(focusable = true): HerdrSessions {
  return {
    repos: [
      {
        repo: "me/proj",
        session_name: "me-proj-abc",
        agents: [
          {
            id: "w1:p1",
            name: "orchestrator #1",
            status: "working",
            pull: 10,
            pull_closed: false,
            focusable,
            workflow: { kind: "parent", runId: 1 },
          },
        ],
        pull_workspaces: [],
        issue_workspaces: [],
      },
    ],
  };
}

function makeWorkflowRunState(
  overrides: Partial<WorkflowRunState> = {},
): WorkflowRunState {
  return {
    id: 1,
    workflow_id: 1,
    workflow_name: "workflow",
    status: "running",
    current_step: "execute",
    rework_count: 0,
    rework_limit: 8,
    cost_increment_usd: 10,
    cost_limit_usd: 10,
    cost_limit_increase_available: false,
    needs_human_reason: null,
    issue_number: 5,
    pr_number: 10,
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
    ended_at: null,
    latest_review: null,
    verification_status: "unverified",
    done: false,
    merge_conflict: false,
    ...overrides,
  };
}

function renderRowWithRun(
  run: WorkflowRunState | null,
  pullOverrides: Partial<LinkedPull> = {},
  handlers: Parameters<typeof mockRpcFetch>[0] = {},
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({ "workflowRuns/stateForPull": () => run, ...handlers }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <LinkedPullSummaryRow
        owner="me"
        repo="proj"
        pull={makePull(pullOverrides)}
      />
    ),
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

describe("LinkedPullSummaryRow workflow mini progress (#1510)", () => {
  it("connects the workflow icon to Execute and opens its orchestrator pane", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    herdrSessionsData.value = herdrWithOrchestrator();
    renderRowWithRun(makeWorkflowRunState());

    const workflow = await screen.findByLabelText("Workflow");
    const node = workflow.parentElement!;
    expect(
      node.nextElementSibling?.getAttribute("data-workflow-connector"),
    ).toBe("workflow-execute");
    expect(node.nextElementSibling?.nextElementSibling?.textContent).toContain(
      "Execute",
    );
    expect(
      screen.queryByRole("button", { name: "Open orchestrator in Herdr" }),
    ).toBeNull();

    fireEvent.mouseEnter(row());
    fireEvent.mouseEnter(node);
    act(() => vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS));

    expect(popoverVisible()).toBe(false);
    const dialog = screen.getByRole("dialog", { name: "Workflow details" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open in Herdr" }),
    );
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p1" },
      expect.anything(),
    );
  });

  it("keeps workflow details but hides stale pane actions after a snapshot failure", async () => {
    herdrSessionsData.value = herdrWithOrchestrator();
    herdrSessionsData.isError = true;
    renderRowWithRun(makeWorkflowRunState());

    fireEvent.focus(await screen.findByLabelText("Workflow"));
    const dialog = screen.getByRole("dialog", { name: "Workflow details" });
    expect(dialog.textContent).toContain("Herdr pane data is unavailable.");
    expect(
      within(dialog).queryByRole("button", { name: "Open in Herdr" }),
    ).toBeNull();
  });

  it("hides workflow pane actions without a focusable parent pane", async () => {
    herdrSessionsData.value = herdrWithOrchestrator(false);
    renderRowWithRun(makeWorkflowRunState());

    fireEvent.focus(await screen.findByLabelText("Workflow"));
    const dialog = screen.getByRole("dialog", { name: "Workflow details" });
    expect(
      within(dialog).queryByRole("button", { name: "Open in Herdr" }),
    ).toBeNull();
  });

  it("reports workflow orchestrator focus failures through the existing toast", async () => {
    herdrSessionsData.value = herdrWithOrchestrator();
    focusHerdrAgent.mockImplementationOnce((_input, options) =>
      options.onError(new Error("pane vanished")),
    );
    renderRowWithRun(makeWorkflowRunState());

    fireEvent.focus(await screen.findByLabelText("Workflow"));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Workflow details" }),
      ).getByRole("button", { name: "Open in Herdr" }),
    );

    expect(showError).toHaveBeenCalledWith("pane vanished");
  });

  it("opens the matching Workflow step pane from the compact tracker", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "lh-me-proj",
          agents: [
            {
              id: "w1:p2",
              name: "executor #1-1",
              status: "working",
              pull: 10,
              pull_closed: false,
              focusable: true,
              workflow: {
                kind: "step",
                runId: 1,
                step: "execute",
                sequence: 1,
              },
            },
          ],
          pull_workspaces: [],
          issue_workspaces: [],
        },
      ],
    };
    renderRowWithRun(makeWorkflowRunState());

    const execute = await screen.findByText("Execute");
    fireEvent.mouseEnter(row());
    fireEvent.mouseEnter(execute.parentElement!);
    act(() => vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS));
    const dialog = screen.getByRole("dialog", {
      name: "Execute workflow step details",
    });
    expect(popoverVisible()).toBe(false);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open in Herdr" }),
    );
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p2" },
      expect.anything(),
    );
  });

  it("renders nothing when the PR has no linked workflow run", async () => {
    renderRowWithRun(null);
    await screen.findByRole("link", { name: "PR #10" });
    expect(document.querySelector("[data-workflow-step-tracker]")).toBeNull();
  });

  it("renders the Execute → Verify → Done tracker and highlights the current step", async () => {
    renderRowWithRun(
      makeWorkflowRunState({
        current_step: "execute",
        verification_status: "unverified",
      }),
    );
    const tracker = (await screen.findByText("Execute")).closest(
      "[data-workflow-step-tracker]",
    );
    expect(tracker).toBeTruthy();
    const within_ = within(tracker as HTMLElement);
    // All three pipeline stages are shown so the whole workflow is visible.
    expect(within_.getByText("Execute")).toBeTruthy();
    expect(within_.getByText("Verify")).toBeTruthy();
    expect(within_.getByText("Done")).toBeTruthy();
    // The run is on Execute, so that stage is the current one.
    expect(within_.getByText("Execute").getAttribute("aria-current")).toBe(
      "step",
    );
    expect(within_.getByText("Verify").getAttribute("aria-current")).toBeNull();
    // Done is not reached yet — no verified check.
    expect(within_.queryByLabelText("verified")).toBeNull();
  });

  it("advances the tracker to Done when Verify passes", async () => {
    renderRowWithRun(
      makeWorkflowRunState({
        current_step: "verify",
        verification_status: "verified",
        done: true,
      }),
    );
    const tracker = (await screen.findByText("Done")).closest(
      "[data-workflow-step-tracker]",
    );
    expect(tracker).toBeTruthy();
    const within_ = within(tracker as HTMLElement);
    // Verify pass is the terminal: Done becomes the current stage.
    expect(within_.getByText("Done").getAttribute("aria-current")).toBe("step");
  });

  it("keeps the Verify stage label plain when verification is stale (#1906)", async () => {
    renderRowWithRun(
      makeWorkflowRunState({
        current_step: "verify",
        verification_status: "stale",
      }),
    );
    const tracker = (await screen.findByText("Done")).closest(
      "[data-workflow-step-tracker]",
    );
    const verify = within(tracker as HTMLElement).getByText("Verify");
    expect(verify.textContent).toBe("Verify");
    expect(verify.className).toContain("amber");
  });

  it("surfaces a needs-human run alongside the tracker", async () => {
    renderRowWithRun(
      makeWorkflowRunState({
        current_step: "verify",
        needs_human_reason: "waiting for a decision",
      }),
    );
    const tracker = (await screen.findByText("needs human")).closest(
      "[data-workflow-step-tracker]",
    );
    expect(tracker).toBeTruthy();
    // The pipeline is still shown; needs-human is an extra marker, not a replacement.
    expect(within(tracker as HTMLElement).getByText("Verify")).toBeTruthy();
  });

  it("flips the mini tracker's Done pill to Conflict! when the PR is in merge conflict (#1659)", async () => {
    renderRowWithRun(
      makeWorkflowRunState({
        current_step: "execute",
        merge_conflict: true,
      }),
    );
    const tracker = (await screen.findByText("Conflict!")).closest(
      "[data-workflow-step-tracker]",
    );
    expect(tracker).toBeTruthy();
    const within_ = within(tracker as HTMLElement);
    // Terminal pill reads Conflict! (danger), the earlier stages are unchanged.
    expect(within_.queryByText("Done")).toBeNull();
    expect(within_.getByText("Conflict!").className).toContain("text-red");
    expect(within_.getByText("Execute")).toBeTruthy();
    expect(within_.getByText("Verify")).toBeTruthy();
  });

  it("does not reach Done for a completed run (completed is not the terminal signal)", async () => {
    renderRowWithRun(
      makeWorkflowRunState({
        status: "completed",
        current_step: "verify",
        verification_status: "verified",
        done: false,
      }),
    );
    // `status === completed` is a separate lifecycle state, so canonical Done stays unreached and
    // Verify remains the current stage.
    const tracker = (await screen.findByText("Done")).closest(
      "[data-workflow-step-tracker]",
    );
    const within_ = within(tracker as HTMLElement);
    expect(within_.getByText("Verify").getAttribute("aria-current")).toBe(
      "step",
    );
    expect(within_.getByText("Done").getAttribute("aria-current")).toBeNull();
  });
});

describe("LinkedPullSummaryRow GitHub link", () => {
  const githubPull = {
    number: 99,
    url: "https://github.com/me/proj/pull/99",
    branch: null,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    github_merged: false,
    github_merged_at: null,
    pushed_sha: null,
  };

  it("places the GitHub link in the right-side group before metadata", async () => {
    renderRowWithRun(null, { github_pull: githubPull });

    const githubLink = await screen.findByTitle("GitHub PR #99");
    const right = githubLink.closest("[data-linked-pull-right]");
    expect(right?.firstElementChild).toBe(githubLink);
    expect(right?.lastElementChild?.textContent).toBe("Agent");
  });

  it("does not add a placeholder when no GitHub PR is linked", async () => {
    renderRowWithRun(null);

    const pullLink = await screen.findByRole("link", { name: "PR #10" });
    const right = pullLink
      .closest("[data-linked-pull-content]")
      ?.querySelector("[data-linked-pull-right]");
    expect(right?.children).toHaveLength(1);
    expect(screen.queryByTitle(/GitHub PR/)).toBeNull();
  });
});

describe("LinkedPullSummaryRow workflow agent activity", () => {
  function herdrWorkingOnPull(step?: "execute" | "verify"): HerdrSessions {
    return {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [
            {
              id: "w1:p2",
              name: "dev #10",
              status: "working",
              pull: 10,
              pull_closed: false,
              focusable: true,
              workflow: step
                ? { kind: "step", runId: 7, step, sequence: 1 }
                : undefined,
            },
          ],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
          issue_workspaces: [],
        },
      ],
    };
  }

  it.each([
    "execute",
    "verify",
  ] as const)("shows the bot and glow inside the latest %s stage", async (step) => {
    herdrSessionsData.value = herdrWorkingOnPull(step);
    renderRowWithRun(
      makeWorkflowRunState({
        id: 7,
        current_step: step,
        verification_status: "unverified",
      }),
    );
    await screen.findByRole("link", { name: "PR #10" });
    expect(
      screen.getByRole("img", {
        name: `${step === "execute" ? "Execute" : "Verify"} agent working`,
      }).className,
    ).toContain("linked-pull-pulse");
    expect(
      screen.getByText(step === "execute" ? "Execute" : "Verify").className,
    ).toContain("workflow-stage-glow");
  });

  it("keeps workflow bots static for a working non-workflow agent", async () => {
    herdrSessionsData.value = herdrWorkingOnPull();
    renderRowWithRun(
      makeWorkflowRunState({
        current_step: "execute",
        verification_status: "unverified",
      }),
    );
    await screen.findByRole("link", { name: "PR #10" });
    const bots = document.querySelectorAll("[data-agent-bot-icon]");
    expect(bots).toHaveLength(3);
    for (const bot of bots) {
      expect(bot.className).not.toContain("linked-pull-pulse");
    }
  });

  it("keeps Done merge-ready while a PR agent is working", async () => {
    herdrSessionsData.value = herdrWorkingOnPull("execute");
    renderRowWithRun(
      makeWorkflowRunState({
        id: 7,
        current_step: "verify",
        verification_status: "verified",
        done: true,
      }),
    );
    await screen.findByRole("link", { name: "PR #10" });
    expect(screen.getByText("Done").className).toContain("text-green");
    expect(screen.getByText("Done").querySelector("svg")).toBeTruthy();
  });

  it("shows no bot when no workflow run is linked", async () => {
    herdrSessionsData.value = herdrWorkingOnPull("execute");
    renderRowWithRun(null);
    await screen.findByRole("link", { name: "PR #10" });
    expect(document.querySelector("[data-agent-bot-icon]")).toBeNull();
  });
});

// #2147: the rework count comes from the issue-list response, so the row shows it without asking
// for the run state per PR.
describe("LinkedPullSummaryRow workflow rework count (#2147)", () => {
  function rework() {
    return document.querySelector("[data-linked-pull-rework]");
  }

  it("shows the count alone, directly left of the cost metrics", async () => {
    renderRowWithRun(null, {
      workflow_rework_count: 3,
      total_tokens: 48002,
    });
    await screen.findByRole("link", { name: "PR #10" });
    const marker = rework();
    expect(marker?.textContent).toBe("3");
    // The looping-arrows icon carries the "rework" meaning the wording used to.
    expect(marker?.querySelector("svg")).not.toBeNull();
    // A separator dot stands between the count and the cost metrics (#2245).
    const separator = marker?.nextElementSibling;
    expect(separator?.textContent).toBe("·");
    expect(separator?.nextElementSibling?.textContent).toContain("48k");
  });

  it("shows nothing for a run that has not reworked yet", async () => {
    renderRowWithRun(null, { workflow_rework_count: 0 });
    await screen.findByRole("link", { name: "PR #10" });
    expect(rework()).toBeNull();
  });

  it("shows nothing for a PR with no workflow run", async () => {
    renderRowWithRun(null);
    await screen.findByRole("link", { name: "PR #10" });
    expect(rework()).toBeNull();
  });
});

// #2394: the comment count is the way in to what was said, so it carries the link to the PR's
// Comments section instead of leaving the reader to open the PR and scroll.
describe("LinkedPullSummaryRow comment count link (#2394)", () => {
  it("links the count to the PR's Comments section", async () => {
    renderRowWithRun(null, { total_comments: 4 });
    const link = await screen.findByRole("link", { name: "4 comments" });
    expect(link.getAttribute("href")).toBe("/r/me/proj/pulls/10#comments");
  });

  it("navigates to the PR's Comments section when clicked", async () => {
    const { router } = renderRowWithRun(null, { total_comments: 1 });
    const link = await screen.findByRole("link", { name: "1 comment" });
    await act(async () => {
      fireEvent.click(link, { button: 0 });
    });
    expect(router.state.location.pathname).toBe("/r/me/proj/pulls/10");
    expect(router.state.location.hash).toBe("comments");
  });

  it("shows nothing for a PR with no comments", async () => {
    renderRowWithRun(null, { total_comments: 0 });
    await screen.findByRole("link", { name: "PR #10" });
    expect(screen.queryByRole("link", { name: /comment/ })).toBeNull();
  });
});

// #1828: the budget action lives in the shared mini progress, so the Issue list row and the Issue
// page attempt row both offer it.
describe("LinkedPullSummaryRow workflow budget (#1828)", () => {
  const held = makeWorkflowRunState({
    cost_limit_usd: 20,
    cost_increment_usd: 10,
    cost_limit_increase_available: true,
    needs_human_reason: "Cost limit exceeded",
  });

  // #1906: the row shows only the badge, and the question opens from it.
  async function openBudgetPrompt() {
    fireEvent.focus(await screen.findByText("over budget"));
    return screen.getByRole("group", { name: "Increase to $30.00?" });
  }

  it("shows nothing while the run is inside its budget (#1906)", async () => {
    renderRowWithRun(makeWorkflowRunState());

    await screen.findByText("Execute");
    expect(screen.queryByText("over budget")).toBeNull();
    expect(screen.queryByText(/^Budget /)).toBeNull();
  });

  // #1932: a held run is always needs-human, so the tracker's marker only repeats the badge.
  it("shows only the over-budget badge, not the tracker's needs human (#1932)", async () => {
    renderRowWithRun(held);

    expect(await screen.findByText("over budget")).toBeTruthy();
    expect(screen.queryByText("needs human")).toBeNull();
  });

  it("keeps the needs-human marker when the run is held for another reason", async () => {
    renderRowWithRun(
      makeWorkflowRunState({ needs_human_reason: "waiting for a decision" }),
    );

    expect(await screen.findByText("needs human")).toBeTruthy();
    expect(screen.queryByText("over budget")).toBeNull();
  });

  it("increases the budget by the run's persisted increment", async () => {
    renderRowWithRun(
      held,
      {},
      {
        "workflowRuns/increaseCostLimit": () => ({
          run: 1,
          increment_usd: 10,
          previous_limit_usd: 20,
          current_limit_usd: 30,
        }),
      },
    );

    const prompt = await openBudgetPrompt();
    const action = within(prompt).getByRole("button", { name: "Yes" });
    await act(async () => {
      fireEvent.click(action);
    });

    expect(rpcCall("workflowRuns/increaseCostLimit")?.params).toMatchObject({
      repo: "me/proj",
      run: 1,
      expected_limit_usd: 20,
    });
  });

  it("does not flash needs human while the parent resumes after an increase", async () => {
    let increased = false;
    renderRowWithRun(
      held,
      {},
      {
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
            run: 1,
            increment_usd: 10,
            previous_limit_usd: 20,
            current_limit_usd: 30,
          };
        },
      },
    );

    const prompt = await openBudgetPrompt();
    await act(async () => {
      fireEvent.click(within(prompt).getByRole("button", { name: "Yes" }));
    });

    expect(screen.queryByText("needs human")).toBeNull();
  });

  it("restores needs human when the reason changes after an increase", async () => {
    let increased = false;
    renderRowWithRun(
      held,
      {},
      {
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
            run: 1,
            increment_usd: 10,
            previous_limit_usd: 20,
            current_limit_usd: 30,
          };
        },
      },
    );

    const prompt = await openBudgetPrompt();
    await act(async () => {
      fireEvent.click(within(prompt).getByRole("button", { name: "Yes" }));
    });

    expect(await screen.findByText("needs human")).toBeTruthy();
  });

  it("surfaces a refused increase through the existing toast", async () => {
    renderRowWithRun(
      held,
      {},
      {
        "workflowRuns/increaseCostLimit": () => {
          throw new RpcFault(409, "Workflow run is not waiting for a human");
        },
      },
    );

    const prompt = await openBudgetPrompt();
    const action = within(prompt).getByRole("button", { name: "Yes" });
    await act(async () => {
      fireEvent.click(action);
    });

    expect(showError).toHaveBeenCalledWith(
      "Workflow run is not waiting for a human",
    );
  });

  it("dismisses the question on No and leaves the run held", async () => {
    renderRowWithRun(held);

    const prompt = await openBudgetPrompt();
    fireEvent.click(within(prompt).getByRole("button", { name: "No" }));

    expect(
      screen.queryByRole("group", { name: "Increase to $30.00?" }),
    ).toBeNull();
    // Declining changes nothing on the server: the hold stays, so the badge stays — it just stops
    // asking again for this limit.
    expect(screen.getByText("over budget")).toBeTruthy();
    fireEvent.focus(screen.getByText("over budget"));
    expect(
      screen.queryByRole("group", { name: "Increase to $30.00?" }),
    ).toBeNull();
    expect(rpcCall("workflowRuns/increaseCostLimit")).toBeUndefined();
  });
});

describe("LinkedPullSummaryRow hover popover", () => {
  it("identifies the popover and omits agents and follow-up input", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    herdrSessionsData.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "me-proj-abc",
          agents: [
            {
              id: "w1:p2",
              name: "dev #10",
              status: "working",
              pull: 10,
              pull_closed: false,
              focusable: true,
            },
          ],
          pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "working" }],
          issue_workspaces: [],
        },
      ],
    };
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.mouseEnter(row());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(popoverVisible()).toBe(true);
    const popover = document.querySelector(
      '[data-debug-component="PullPopover"]',
    );
    expect(popover).toBeTruthy();
    expect(within(popover as HTMLElement).queryByText("dev #10")).toBeNull();
    expect(
      within(popover as HTMLElement).queryByPlaceholderText(
        "Send a follow-up instruction…",
      ),
    ).toBeNull();
  });
});

describe("LinkedPullSummaryRow hover popover delay", () => {
  it("does not show the popover immediately on hover", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.mouseEnter(row());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS - 1);
    });
    expect(popoverVisible()).toBe(false);
  });

  it("shows the popover once the hover delay elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.mouseEnter(row());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
    expect(popoverVisible()).toBe(true);
    expect(screen.queryByRole("link", { name: "Open PR #10" })).toBeNull();

    const [, headerLink] = screen.getAllByRole("link", { name: "PR #10" });
    expect(headerLink.getAttribute("href")).toBe("/r/me/proj/pulls/10");
  });

  it("cancels the pending popover when the pointer leaves during the delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.mouseEnter(row());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS - 1);
    });
    fireEvent.mouseLeave(row());
    // Advancing well past the original delay must never flash the popover open.
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS * 2);
    });
    expect(popoverVisible()).toBe(false);
  });

  it("opens immediately on keyboard focus without any delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(row());
    expect(popoverVisible()).toBe(true);
  });

  it("keeps the popover open while keyboard focus moves to its header link", async () => {
    renderRow();
    const trigger = await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(trigger);
    const [, headerLink] = screen.getAllByRole("link", { name: "PR #10" });
    fireEvent.blur(trigger, { relatedTarget: headerLink });
    act(() => headerLink.focus());

    expect(popoverVisible()).toBe(true);
    expect(document.activeElement).toBe(headerLink);
  });

  it("closes on Escape", async () => {
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(row());
    expect(popoverVisible()).toBe(true);
    fireEvent.keyDown(row(), { key: "Escape" });
    expect(popoverVisible()).toBe(false);
  });

  it("closes on blur to an element outside the row", async () => {
    renderRow();
    await screen.findByRole("link", { name: "PR #10" });

    fireEvent.focus(row());
    expect(popoverVisible()).toBe(true);
    fireEvent.blur(row(), { relatedTarget: document.body });
    expect(popoverVisible()).toBe(false);
  });
});
