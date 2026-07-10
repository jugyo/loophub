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
import type { PevrRunState } from "@/api/types";
import { PevrRunStatusSection } from "./pevr-run-status";

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

function state(partial: Partial<PevrRunState>): PevrRunState {
  return {
    id: 7,
    workflow_id: 3,
    workflow_name: "standard",
    status: "running",
    current_step: "plan",
    rework_count: 0,
    issue_number: 42,
    pr_number: 99,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    latest_verdict: null,
    ...partial,
  };
}

describe("PevrRunStatusSection", () => {
  it("renders nothing when there is no run", () => {
    const { container } = renderInRouter(
      <PevrRunStatusSection owner="me" repo="loophub" state={null} />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows workflow name, status, current step, and rework count for a running run", async () => {
    renderInRouter(
      <PevrRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          status: "running",
          current_step: "execute",
          rework_count: 2,
        })}
      />,
    );
    expect(await screen.findByText("PEVR run")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("standard")).toBeTruthy();
    expect(screen.getByText("· rework ×2")).toBeTruthy();
    // Current step is marked with aria-current="step".
    const current = screen.getByText("Execute");
    expect(current.getAttribute("aria-current")).toBe("step");
  });

  it("shows the completed message when the run finished Reflect", async () => {
    renderInRouter(
      <PevrRunStatusSection
        owner="me"
        repo="loophub"
        state={state({ status: "completed", current_step: "reflect" })}
      />,
    );
    expect(await screen.findByText("Completed")).toBeTruthy();
    expect(screen.getByText(/Reflect complete/)).toBeTruthy();
  });

  it("does not claim Reflect complete when a completed run's step is not reflect", async () => {
    renderInRouter(
      <PevrRunStatusSection
        owner="me"
        repo="loophub"
        state={state({ status: "completed", current_step: "verify" })}
      />,
    );
    expect(await screen.findByText("Completed")).toBeTruthy();
    expect(screen.getByText("The PEVR run is completed.")).toBeTruthy();
    expect(screen.queryByText(/Reflect complete/)).toBeNull();
  });

  it("surfaces the block reason, verdict summary, and issue / inbox links when blocked", async () => {
    renderInRouter(
      <PevrRunStatusSection
        owner="me"
        repo="loophub"
        state={state({
          status: "blocked",
          current_step: "verify",
          issue_number: 42,
          latest_verdict: {
            event: "request_changes",
            summary: "Two criteria unmet.",
            findings_count: 2,
          },
        })}
      />,
    );
    expect(await screen.findByText("Blocked")).toBeTruthy();
    expect(
      screen.getByText(/This run is blocked and needs a human/),
    ).toBeTruthy();
    expect(screen.getByText(/Two criteria unmet\./)).toBeTruthy();
    const issueLink = screen.getByText("Read issue #42");
    expect(issueLink.closest("a")?.getAttribute("href")).toBe(
      "/r/me/loophub/issues/42",
    );
    const inboxLink = screen.getByText("Open Inbox");
    expect(inboxLink.closest("a")?.getAttribute("href")).toBe("/inbox");
  });
});
