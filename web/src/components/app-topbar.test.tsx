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
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@/api/types";
import { AppTopbar } from "./app-topbar";

const reposData = vi.hoisted(() => ({
  value: [] as Repo[],
  isLoading: false,
  isError: false,
}));

vi.mock("@/queries/repos", () => ({
  useRepos: () => ({
    data: reposData.value,
    isLoading: reposData.isLoading,
    isError: reposData.isError,
  }),
}));

vi.mock("@/lib/use-theme", () => ({
  useTheme: () => ({
    theme: "light",
    toggle: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  reposData.value = [];
  reposData.isLoading = false;
  reposData.isError = false;
});

function repo(
  fullName: string,
  id: number,
  overrides: Partial<Repo> = {},
): Repo {
  return {
    id,
    name: fullName.split("/")[1],
    full_name: fullName,
    owner: { login: fullName.split("/")[0] },
    default_branch: "main",
    local_path: `/tmp/${id}`,
    archived: false,
    archived_at: null,
    favorite: false,
    favorited_at: null,
    created_at: "2026-01-01T00:00:00Z",
    merge_mode: null,
    herdr_session_name: "repo-abcd1234",
    ...overrides,
  };
}

function renderTopbar(initialPath = "/") {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AppTopbar />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => null,
  });
  const statsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/stats",
    component: () => null,
  });
  const archivedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/archived",
    component: () => null,
  });
  const eventDebugRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/debug/events",
    component: () => null,
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      settingsRoute,
      statsRoute,
      archivedRoute,
      eventDebugRoute,
      repoRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return {
    router,
    ...render(<RouterProvider router={router} />),
  };
}

describe("AppTopbar", () => {
  it("renders the required top-level links without Archived in the topbar", async () => {
    const { container } = renderTopbar();
    await screen.findByRole("link", { name: /LoopHub/ });

    expect(
      screen.getByRole("link", { name: "Stats" }).getAttribute("href"),
    ).toBe("/stats");
    expect(
      screen.getByRole("link", { name: "Events" }).getAttribute("href"),
    ).toBe("/debug/events");
    expect(
      screen.getByRole("link", { name: "Settings" }).getAttribute("href"),
    ).toBe("/settings");
    expect(
      screen.queryByRole("link", { name: "Archived repositories" }),
    ).toBeNull();

    const headerItems = [...container.querySelectorAll("header > *")];
    const repoPickerIndex = headerItems.findIndex((node) =>
      node.querySelector?.("[aria-label='Repository']"),
    );
    const themeIndex = headerItems.findIndex(
      (node) => node.getAttribute("aria-label") === "Theme",
    );
    expect(repoPickerIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeGreaterThan(repoPickerIndex);
  });

  it("shows the current repository and switches to another active repository", async () => {
    reposData.value = [
      repo("me/zulu", 1),
      repo("me/alpha", 2, { favorite: true }),
    ];
    const { router } = renderTopbar("/r/me/zulu");

    const select = (await screen.findByRole("combobox", {
      name: "Repository",
    })) as HTMLSelectElement;
    expect(select.value).toBe("me/zulu");

    fireEvent.change(select, { target: { value: "me/alpha" } });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/me/alpha"),
    );
  });

  it("keeps cached repository navigation enabled after a background refresh error", async () => {
    reposData.value = [repo("me/zulu", 1), repo("me/alpha", 2)];
    reposData.isError = true;
    const { router } = renderTopbar("/r/me/zulu");

    const select = (await screen.findByRole("combobox", {
      name: "Repository",
    })) as HTMLSelectElement;
    expect(select.disabled).toBe(false);

    fireEvent.change(select, { target: { value: "me/alpha" } });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/me/alpha"),
    );
  });

  it("does not render the old sidebar Agents list as top-level navigation", async () => {
    renderTopbar();
    await screen.findByRole("link", { name: /LoopHub/ });

    expect(screen.queryByText("Repositories")).toBeNull();
    expect(screen.queryByText("Agents")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});
