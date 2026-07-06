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
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, repoRoute]),
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
        seeAllTo="/r/$owner/$repo"
        seeAllParams={{ owner: "me", repo: "proj" }}
        emptyText="No open issues."
        keyOf={(s) => s}
        renderItem={(s) => <span>{s}</span>}
      />,
    );
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    const seeAll = screen.getByText("See all").closest("a");
    expect(seeAll?.getAttribute("href")).toBe("/r/me/proj");
  });

  it("renders a footerNote below the list when provided", async () => {
    renderInRouter(
      <DashboardSection<string>
        title="Recent issues"
        query={result<string>({ data: ["alpha"] })}
        emptyText="No open issues."
        keyOf={(s) => s}
        renderItem={(s) => <span>{s}</span>}
        footerNote="Showing the 100 most recent."
      />,
    );
    expect(
      await screen.findByText("Showing the 100 most recent."),
    ).toBeTruthy();
  });

  it("omits the footerNote when none is provided", async () => {
    renderInRouter(
      <DashboardSection<string>
        title="Recent issues"
        query={result<string>({ data: ["alpha"] })}
        emptyText="No open issues."
        keyOf={(s) => s}
        renderItem={(s) => <span>{s}</span>}
      />,
    );
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.queryByText(/most recent/)).toBeNull();
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
