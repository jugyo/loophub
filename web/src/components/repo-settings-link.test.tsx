import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoSettingsLink } from "./repo-settings-link";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderLink() {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <RepoSettingsLink owner="me" repo="proj" />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings",
    component: () => <div data-testid="settings-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("RepoSettingsLink", () => {
  it("shows the settings link directly, without a menu to open", async () => {
    renderLink();
    expect(await screen.findByRole("link", { name: /settings/i })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("navigates to the repo settings screen", async () => {
    renderLink();
    fireEvent.click(await screen.findByRole("link", { name: /settings/i }));
    expect(await screen.findByTestId("settings-page")).toBeTruthy();
  });
});
