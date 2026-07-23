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
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrSessions, WorkflowRunState } from "@/api/types";

const mocks = vi.hoisted(() => ({
  herdrSessions: undefined as HerdrSessions | undefined,
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

import { WorkflowRunStatusSection } from "./workflow-run-status";

afterEach(() => {
  cleanup();
  mocks.herdrSessions = undefined;
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
  return {
    id: 7,
    workflow_id: 3,
    workflow_name: "standard",
    status: "running",
    current_step: "execute",
    rework_count: 0,
    needs_human_reason: null,
    issue_number: 42,
    pr_number: 99,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    latest_review: null,
    verification_status: "unverified",
    ...partial,
  };
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

  it("shows workflow name, status, current step, and rework count for a running run", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          status: "running",
          current_step: "execute",
          rework_count: 2,
        })}
      />,
    );
    expect(await screen.findByText("Workflow run")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("standard")).toBeTruthy();
    expect(screen.getByText("· rework ×2")).toBeTruthy();
    // Current step is marked with aria-current="step".
    const current = screen.getByText("Execute");
    expect(current.getAttribute("aria-current")).toBe("step");
  });

  it("shows the completed message when the run passed Verify", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({ status: "completed", current_step: "verify" })}
      />,
    );
    expect(await screen.findByText("Completed")).toBeTruthy();
    expect(screen.getByText(/Verify passed/)).toBeTruthy();
  });

  it("does not claim Verify passed when a completed run's step is not verify", async () => {
    renderInRouter(
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state({ status: "completed", current_step: "execute" })}
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
        })}
      />,
    );
    expect(await screen.findByText("Verified")).toBeTruthy();
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
