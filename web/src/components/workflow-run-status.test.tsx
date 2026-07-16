import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@/api/types";
import { WorkflowRunStatusSection } from "./workflow-run-status";

afterEach(cleanup);

// The section renders <Link> to the issue and inbox, which need a router context.
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
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, issueRoute, inboxRoute]),
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
    ...partial,
  };
}

describe("WorkflowRunStatusSection", () => {
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

  it("surfaces the wait reason, review summary, and issue / inbox links while waiting for a human", async () => {
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
    const inboxLink = screen.getByText("Open Inbox");
    expect(inboxLink.closest("a")?.getAttribute("href")).toBe("/inbox");
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
