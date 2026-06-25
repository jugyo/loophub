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
import { AppBreadcrumb } from "./app-breadcrumb";
import { DetailTitleContext } from "./detail-title";

afterEach(cleanup);

// AppBreadcrumb reads the pathname via the router and the detail title via
// context; render it inside both at a given path with a fixed title state.
function renderBreadcrumb(
  path: string,
  detail: { title: string | null; bodyVisible: boolean },
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => (
      <DetailTitleContext.Provider
        value={{ ...detail, setTitle: () => {}, setBodyVisible: () => {} }}
      >
        <AppBreadcrumb />
      </DetailTitleContext.Provider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("AppBreadcrumb", () => {
  it("renders the path segments", async () => {
    renderBreadcrumb("/r/me/proj/issues/12", {
      title: null,
      bodyVisible: true,
    });
    expect(await screen.findByText("me/proj")).toBeTruthy();
    expect(screen.getByText("Issues")).toBeTruthy();
    expect(screen.getByText("#12")).toBeTruthy();
  });

  it("hides the detail title while the body heading is visible", async () => {
    renderBreadcrumb("/r/me/proj/issues/12", {
      title: "Add breadcrumb title",
      bodyVisible: true,
    });
    const title = await screen.findByText("Add breadcrumb title");
    const item = title.closest("li");
    expect(item?.getAttribute("data-state")).toBe("hidden");
    expect(item?.getAttribute("aria-hidden")).toBe("true");
  });

  it("reveals the detail title once the body heading scrolls out of view", async () => {
    renderBreadcrumb("/r/me/proj/issues/12", {
      title: "Add breadcrumb title",
      bodyVisible: false,
    });
    const title = await screen.findByText("Add breadcrumb title");
    const item = title.closest("li");
    expect(item?.getAttribute("data-state")).toBe("visible");
    expect(item?.getAttribute("aria-hidden")).toBe("false");
    // Long titles are width-capped and ellipsised within the breadcrumb.
    expect(title.className).toContain("truncate");
    expect(item?.className).toContain("max-w-");
  });

  it("renders no title crumb when there is no detail title", async () => {
    renderBreadcrumb("/r/me/proj/issues/12", {
      title: null,
      bodyVisible: false,
    });
    await screen.findByText("#12");
    expect(screen.queryByText("Add breadcrumb title")).toBeNull();
  });
});
