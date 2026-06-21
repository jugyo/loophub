import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
} from "@tanstack/react-router";
import type { Issue } from "@/api/types";
import { IssueRow } from "./dashboard-rows";

afterEach(cleanup);

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    state: "open",
    title: "Example issue",
    body: "",
    user: { login: "me" },
    assignee: null,
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// IssueRow renders <Link>, which needs a router context.
function renderInRouter(ui: React.ReactNode) {
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
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
});
