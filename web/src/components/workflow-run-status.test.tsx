import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HerdrSessions,
  WorkflowRunState,
  WorkflowRunTotalCost,
} from "@/api/types";
import { makeWorkflowRunState } from "@/api/workflow-run-state-mock";

const mocks = vi.hoisted(() => ({
  herdrSessions: undefined as HerdrSessions | undefined,
  totalCost: {
    cost_usd: null,
    cost_status: "not_recorded",
  } as WorkflowRunTotalCost,
  totalCostError: false,
  focusHerdrAgent: vi.fn(),
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({
    data: mocks.herdrSessions,
    isError: false,
  }),
  useFocusHerdrAgent: () => ({
    mutate: mocks.focusHerdrAgent,
    isPending: false,
  }),
}));
vi.mock("@/queries/workflow-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/queries/workflow-runs")>()),
  useWorkflowRunTotalCost: () => ({
    data: mocks.totalCost,
    isLoading: false,
    isError: mocks.totalCostError,
  }),
}));

import { WorkflowRunStatusSection } from "./workflow-run-status";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.herdrSessions = undefined;
  mocks.totalCost = { cost_usd: null, cost_status: "not_recorded" };
  mocks.totalCostError = false;
  mocks.focusHerdrAgent.mockClear();
});

// The section renders a <Link> to the issue, which needs a router context.
function renderInRouter(ui: React.ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, issueRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

function state(partial: Partial<WorkflowRunState>): WorkflowRunState {
  return makeWorkflowRunState({
    workflow_name: "standard",
    ...partial,
  });
}

describe("WorkflowRunStatusSection", () => {
  it("opens the matching Workflow step pane from the detail tracker", async () => {
    mocks.herdrSessions = {
      repos: [
        {
          repo: "me/loophub",
          session_name: "lh-me-loophub",
          agents: [
            {
              id: "w7:p1",
              name: "executor #7-1",
              status: "working",
              pull: 99,
              pull_closed: false,
              focusable: true,
              workflow: {
                kind: "step",
                runId: 7,
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
    renderInRouter(
      <WorkflowRunStatusSection owner="me" repo="loophub" state={state({})} />,
    );

    fireEvent.focus(await screen.findByText("Execute"));
    const dialog = screen.getByRole("dialog", {
      name: "Execute workflow step details",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open in Herdr" }),
    );
    expect(mocks.focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/loophub", paneId: "w7:p1" },
      expect.anything(),
    );
  });

  it("renders nothing when there is no run", () => {
    const { container } = renderInRouter(
      <WorkflowRunStatusSection owner="me" repo="loophub" state={null} />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows workflow name, status, current step, and rework count / limit for a running run", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          status: "running",
          current_step: "execute",
          rework_count: 2,
          rework_limit: 8,
        })}
      />,
    );
    const heading = await screen.findByRole("heading", { name: "Workflow" });
    expect(heading.className).toBe("text-lg font-semibold");
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("standard")).toBeTruthy();
    const metadata = document.querySelector(
      '[data-debug-component="WorkflowRunMetadata"]',
    );
    expect(metadata).toBeTruthy();
    expect(
      within(metadata as HTMLElement).getByText("Rework: 2/8"),
    ).toBeTruthy();
    const tracker = document.querySelector(
      '[data-debug-component="WorkflowStepTracker"]',
    );
    expect(
      tracker?.compareDocumentPosition(metadata as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Current step is marked with aria-current="step".
    const current = screen.getByText("Execute");
    expect(current.getAttribute("aria-current")).toBe("step");
  });

  it("shows the total cost of the Workflow run using the shared cost format", async () => {
    mocks.totalCost = { cost_usd: 0.0092, cost_status: "known" };

    renderInRouter(
      <WorkflowRunStatusSection owner="me" repo="loophub" state={state({})} />,
    );

    expect(await screen.findByText("Total cost")).toBeTruthy();
    expect(screen.getByText("$0.0092")).toBeTruthy();
  });

  it.each([
    [{ cost_usd: 1.25, cost_status: "partial" }, "$1.25+"],
    [{ cost_usd: null, cost_status: "pending" }, "Pending"],
    [{ cost_usd: null, cost_status: "unknown" }, "Unknown"],
  ] as const)("shows the core-provided incomplete cost state", async (totalCost, expected) => {
    mocks.totalCost = totalCost;

    renderInRouter(
      <WorkflowRunStatusSection owner="me" repo="loophub" state={state({})} />,
    );

    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("shows n/a when the run has no recorded agent sessions", async () => {
    renderInRouter(
      <WorkflowRunStatusSection owner="me" repo="loophub" state={state({})} />,
    );

    expect(await screen.findByText("n/a")).toBeTruthy();
  });

  it("shows a visible error when the total cost request fails", async () => {
    mocks.totalCostError = true;
    renderInRouter(
      <WorkflowRunStatusSection owner="me" repo="loophub" state={state({})} />,
    );

    const failure = await screen.findByText("Failed to load total cost.");
    expect(failure.className).toContain("text-destructive");
    expect(screen.queryByText("n/a")).toBeNull();
  });

  it("shows one live elapsed duration for a running run", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date("2026-07-10T00:01:30Z").getTime());
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({ created_at: "2026-07-10T00:00:00Z" })}
      />,
    );

    const duration = await screen.findByText("Duration: 1m 30s elapsed");
    expect(duration.tagName).toBe("P");
    expect(duration.parentElement?.dataset.debugComponent).toBe(
      "WorkflowRunMetadata",
    );
    expect(
      document.querySelectorAll('[data-debug-component="WorkflowRunDuration"]'),
    ).toHaveLength(1);

    now.mockReturnValue(new Date("2026-07-10T00:02:00Z").getTime());
    await waitFor(
      () => expect(screen.getByText("Duration: 2m elapsed")).toBeTruthy(),
      { timeout: 2000 },
    );
  });

  it("shows the fixed start-to-end total for a completed run", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          status: "completed",
          created_at: "2026-07-10T00:00:00Z",
          updated_at: "2026-07-11T00:00:00Z",
          ended_at: "2026-07-10T01:01:01Z",
        })}
      />,
    );

    expect(await screen.findByText("Duration: 1h 1m total")).toBeTruthy();
    expect(screen.queryByText(/elapsed$/)).toBeNull();
  });

  it("omits the duration when a Workflow timestamp is invalid", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({ created_at: "invalid" })}
      />,
    );

    expect(await screen.findByText("Running")).toBeTruthy();
    expect(screen.queryByText(/(?:elapsed|total)$/)).toBeNull();
  });

  // A completed run means its PR merged (#1808), which can happen from any step and without a fresh
  // pass, so the message never claims Verify passed.
  it.each([
    "verify",
    "execute",
  ])("shows the completed message for a completed run at %s", async (current_step) => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({ status: "completed", current_step })}
      />,
    );
    expect(await screen.findByText("Completed")).toBeTruthy();
    expect(screen.getByText("The Workflow run is completed.")).toBeTruthy();
    expect(screen.queryByText(/Verify passed/)).toBeNull();
  });

  it("keeps a verified running run free of continuing status text", async () => {
    const { rerender } = renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          current_step: "verify",
          verification_status: "verified",
          done: true,
        })}
      />,
    );
    expect(await screen.findByText("Ready to merge")).toBeTruthy();
    expect(
      screen.getByText("Verify passed for the current HEAD."),
    ).toBeTruthy();
    expect(screen.queryByText(/continuing/i)).toBeNull();

    rerender(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          current_step: "verify",
          verification_status: "stale",
        })}
      />,
    );
    expect(await screen.findByText(/fresh Verify is required/)).toBeTruthy();
    expect(screen.getByText("Reverify required")).toBeTruthy();
  });

  it("does not present merge-ready Done as a workflow Verify pass", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          current_step: "verify",
          verification_status: "unverified",
          done: true,
        })}
      />,
    );

    expect(await screen.findByText("Ready to merge")).toBeTruthy();
    expect(screen.queryByText("Verified")).toBeNull();
    expect(screen.queryByText(/Verify passed/)).toBeNull();
  });

  it("shows merge-ready Done when agent status is unavailable", async () => {
    const verifiedState = state({
      current_step: "verify",
      verification_status: "verified",
      done: true,
    });
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={verifiedState}
      />,
    );

    const done = await screen.findByText("Done");
    expect(done.className).toContain("text-green");
    expect(done.querySelector("svg")).toBeTruthy();
  });

  it("surfaces the wait reason, review summary, and issue link while waiting for a human", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          status: "running",
          current_step: "verify",
          needs_human_reason: "rework limit exceeded: two criteria unmet",
          issue_number: 42,
          latest_review: {
            id: 5,
            event: "request_changes",
            summary: "Two criteria unmet.",
            findings_count: 2,
            ac_results: [],
          },
        })}
      />,
    );
    expect(await screen.findByText("Needs human")).toBeTruthy();
    expect(
      screen.getByText(/waiting for a human instruction to its parent session/),
    ).toBeTruthy();
    expect(
      screen.getByText("rework limit exceeded: two criteria unmet"),
    ).toBeTruthy();
    expect(screen.getByText(/Two criteria unmet\./)).toBeTruthy();
    const issueLink = screen.getByText("Read issue #42");
    expect(issueLink.closest("a")?.getAttribute("href")).toBe(
      "/r/me/loophub/issues/42",
    );
    expect(screen.queryByText("Open Inbox")).toBeNull();
  });

  it("renders a legacy blocked run as a terminal Needs human state", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          status: "blocked",
          current_step: "verify",
          issue_number: 42,
          latest_review: {
            id: 5,
            event: "request_changes",
            summary: "Two criteria unmet.",
            findings_count: 2,
            ac_results: [],
          },
        })}
      />,
    );
    expect(await screen.findByText("Needs human")).toBeTruthy();
    expect(
      screen.getByText(/escalated to a human and is no longer running/),
    ).toBeTruthy();
    expect(screen.getByText(/Two criteria unmet\./)).toBeTruthy();
    expect(screen.getByText("Read issue #42")).toBeTruthy();
  });
});
