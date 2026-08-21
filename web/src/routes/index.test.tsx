import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHome() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: HomePage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("HomePage", () => {
  it("shows a placeholder without repository management entry points", async () => {
    renderHome();

    expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Repositories" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add repository" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Archived repositories" }),
    ).toBeNull();
  });
});
