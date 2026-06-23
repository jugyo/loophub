import type { UseQueryResult } from "@tanstack/react-query";
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
import { DashboardSection } from "./dashboard-section";

afterEach(cleanup);

function result<T>(partial: Partial<UseQueryResult<T[]>>): UseQueryResult<T[]> {
  return partial as UseQueryResult<T[]>;
}

// DashboardSection renders <Link>, which needs a router context.
function renderInRouter(ui: React.ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const issuesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, issuesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("DashboardSection", () => {
  it("shows the empty text when there are no items", async () => {
    renderInRouter(
      <DashboardSection<string>
        title="Open Issues"
        query={result<string>({ data: [] })}
        emptyText="No open issues."
        keyOf={(s) => s}
        renderItem={(s) => <span>{s}</span>}
      />,
    );
    expect(await screen.findByText("No open issues.")).toBeTruthy();
  });

  it("renders items and a working 'see all' link to the list view", async () => {
    renderInRouter(
      <DashboardSection<string>
        title="Open Issues"
        query={result<string>({ data: ["alpha", "beta"] })}
        seeAllTo="/r/$owner/$repo/issues"
        seeAllParams={{ owner: "me", repo: "proj" }}
        emptyText="No open issues."
        keyOf={(s) => s}
        renderItem={(s) => <span>{s}</span>}
      />,
    );
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    const seeAll = screen.getByText("See all").closest("a");
    expect(seeAll?.getAttribute("href")).toBe("/r/me/proj/issues");
  });

  it("renders a header action next to the title", async () => {
    renderInRouter(
      <DashboardSection<string>
        title="Open Issues"
        query={result<string>({ data: [] })}
        emptyText="No open issues."
        keyOf={(s) => s}
        renderItem={(s) => <span>{s}</span>}
        headerAction={<button>New issue</button>}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "New issue" }),
    ).toBeTruthy();
  });
});
