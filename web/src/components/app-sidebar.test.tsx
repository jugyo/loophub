import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrSessions, Repo } from "@/api/types";

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
  useSetRepoFavorite: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

const herdrSessions = vi.hoisted(() => ({
  value: undefined as HerdrSessions | undefined,
  isError: false,
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({
    data: herdrSessions.value,
    isError: herdrSessions.isError,
  }),
}));

vi.mock("@/components/sidebar-herdr-sessions", () => ({
  SidebarHerdrSessions: () => null,
}));

import { AppSidebar, countRepoHerdrAgents } from "./app-sidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  reposData.value = [];
  reposData.isLoading = false;
  reposData.isError = false;
  herdrSessions.value = undefined;
  herdrSessions.isError = false;
  localStorage.clear();
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
    ...overrides,
  };
}

function renderSidebar() {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: AppSidebar,
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
      repoRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("AppSidebar repositories", () => {
  it("sorts favorites before non-favorites, alphabetically within each group", async () => {
    reposData.value = [
      repo("me/zulu", 1),
      repo("me/alpha", 2, { favorite: true }),
      repo("Acme/widget", 3),
      repo("me/Yankee", 4, { favorite: true }),
      repo("acme/Alpha", 5),
    ];

    const { container } = renderSidebar();
    await screen.findByText("me/zulu");

    const order = [...container.querySelectorAll("a")]
      .map((a) => a.textContent?.trim())
      .filter((text) => text?.includes("/"));
    expect(order).toEqual([
      "me/alpha",
      "me/Yankee",
      "acme/Alpha",
      "Acme/widget",
      "me/zulu",
    ]);
  });
});

describe("AppSidebar Herdr repo counts", () => {
  it("counts every Herdr agent for the matching repository", () => {
    expect(
      countRepoHerdrAgents(
        {
          repos: [
            {
              repo: "me/proj",
              session_name: "lh-me-proj",
              agents: [
                { id: "%1", name: "working", status: "working" },
                { id: "%2", name: "idle", status: "idle" },
                { id: "%3", name: "blocked", status: "blocked" },
                { id: "%4", name: "done", status: "done" },
              ],
              pull_workspaces: [],
            },
            {
              repo: "me/other",
              session_name: "lh-me-other",
              agents: [{ id: "%5", name: "other", status: "working" }],
              pull_workspaces: [],
            },
          ],
        },
        "me/proj",
      ),
    ).toBe(4);
  });

  it("shows an agent count only for repositories with running Herdr agents", async () => {
    reposData.value = [repo("me/proj", 1), repo("me/quiet", 2)];
    herdrSessions.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "lh-me-proj",
          agents: [
            { id: "%1", name: "dev #1", status: "working" },
            { id: "%2", name: "dev #2", status: "done" },
          ],
          pull_workspaces: [],
        },
      ],
    };

    renderSidebar();

    expect(await screen.findByLabelText("2 running agents")).toBeTruthy();
    expect(screen.queryByLabelText("0 running agents")).toBeNull();
  });

  it("hides repo Herdr counts while the sessions query is errored", async () => {
    reposData.value = [repo("me/proj", 1)];
    herdrSessions.value = {
      repos: [
        {
          repo: "me/proj",
          session_name: "lh-me-proj",
          agents: [{ id: "%1", name: "dev #1", status: "working" }],
          pull_workspaces: [],
        },
      ],
    };
    herdrSessions.isError = true;

    renderSidebar();

    expect(await screen.findByText("me/proj")).toBeTruthy();
    expect(screen.queryByLabelText("1 running agent")).toBeNull();
  });
});
