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
    expect(screen.getByText("#12")).toBeTruthy();
    expect(screen.queryByText("Issues")).toBeNull();
  });

  it("hides the detail title while the body heading is visible", async () => {
    renderBreadcrumb("/r/me/proj/issues/12", {
      title: "Add breadcrumb title",
      bodyVisible: true,
    });
    const title = await screen.findByText("Add breadcrumb title");
    expect(title.getAttribute("data-state")).toBe("hidden");
    expect(title.getAttribute("aria-hidden")).toBe("true");
  });

  it("reveals the detail title once the body heading scrolls out of view", async () => {
    renderBreadcrumb("/r/me/proj/issues/12", {
      title: "Add breadcrumb title",
      bodyVisible: false,
    });
    const title = await screen.findByText("Add breadcrumb title");
    expect(title.getAttribute("data-state")).toBe("visible");
    expect(title.getAttribute("aria-hidden")).toBe("false");
    // The title grows to fill the remaining row width (flex-1) and ellipsises
    // only once it hits the container edge; min-w-0 lets it shrink first so a
    // long title never pushes out `#id` or the leading crumbs.
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("flex-1");
    expect(title.className).toContain("min-w-0");
  });

  it("shares the `#id` crumb with the title and renders no separator between them", async () => {
    renderBreadcrumb("/r/me/proj/issues/12", {
      title: "Add breadcrumb title",
      bodyVisible: false,
    });
    const title = await screen.findByText("Add breadcrumb title");
    // `#id` and the title live in the same crumb (li); there is no chevron
    // separator between them, so they read as one target rather than `#id > title`.
    const item = title.closest("li");
    expect(item?.textContent).toContain("#12");
    expect(item?.querySelector("[role='presentation']")).toBeNull();
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
