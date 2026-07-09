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
    setTheme: vi.fn(),
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

function makeRepo(
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

function renderTopbar(initialPath = "/", onOpenRepoSwitcher = vi.fn()) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AppTopbar onOpenRepoSwitcher={onOpenRepoSwitcher} />
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
    onOpenRepoSwitcher,
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

    const rows = [...container.querySelectorAll("header > [role='group']")];
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("aria-label")).toBe("Primary topbar");
    expect(screen.queryByLabelText("Secondary topbar")).toBeNull();
    expect(screen.queryByLabelText("Agent cost summary")).toBeNull();

    const primaryItems = [...rows[0].children];
    const repoPickerIndex = primaryItems.findIndex((node) =>
      node.querySelector?.("[aria-label='Repository']"),
    );
    const themeIndex = primaryItems.findIndex(
      (node) => node.getAttribute("aria-label") === "Theme",
    );
    expect(repoPickerIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeGreaterThan(repoPickerIndex);
    expect(themeIndex).toBe(primaryItems.length - 1);
  });

  it("opens the Cmd+K repository picker from the repository control", async () => {
    reposData.value = [
      makeRepo("me/zulu", 1),
      makeRepo("me/alpha", 2, { favorite: true }),
    ];
    const { onOpenRepoSwitcher } = renderTopbar("/r/me/zulu");

    const trigger = await screen.findByRole("button", {
      name: "Repository: me/zulu",
    });
    expect(trigger.textContent).toContain("me/zulu");
    expect(trigger.textContent).toContain("K");
    expect(trigger.textContent).not.toContain("Cmd");
    expect(trigger.getAttribute("aria-label")).toBe("Repository: me/zulu");
    expect(trigger.getAttribute("title")).toBe("Switch repository");

    fireEvent.click(trigger);

    expect(onOpenRepoSwitcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("keeps the repository picker available after a background refresh error", async () => {
    reposData.value = [makeRepo("me/zulu", 1), makeRepo("me/alpha", 2)];
    reposData.isError = true;
    const { onOpenRepoSwitcher } = renderTopbar("/r/me/zulu");

    const trigger = await screen.findByRole("button", {
      name: "Repository: me/zulu",
    });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(trigger);

    expect(onOpenRepoSwitcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the repository picker available when no repositories are available", async () => {
    const { onOpenRepoSwitcher } = renderTopbar();

    const trigger = await screen.findByRole("button", { name: "Repository" });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(trigger);

    expect(onOpenRepoSwitcher).toHaveBeenCalledTimes(1);
  });

  it("does not render the old sidebar Agents list as top-level navigation", async () => {
    renderTopbar();
    await screen.findByRole("link", { name: /LoopHub/ });

    expect(screen.queryByText("Repositories")).toBeNull();
    expect(screen.queryByText("Agents")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("does not render the topbar cost summary", async () => {
    renderTopbar();
    await screen.findByRole("link", { name: /LoopHub/ });

    expect(screen.queryByLabelText("Agent cost summary")).toBeNull();
    expect(screen.queryByText("Cost")).toBeNull();
    expect(screen.queryByText("Loading...")).toBeNull();
    expect(screen.queryByText("n/a")).toBeNull();
  });
});
