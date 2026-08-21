import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import type { Repo } from "@/api/types";
import { RepositoriesPage } from "./repositories-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function repo(full_name: string, id: number, archived = false): Repo {
  return {
    id,
    name: full_name.split("/")[1],
    full_name,
    owner: { login: full_name.split("/")[0] },
    default_branch: "main",
    local_path: `/tmp/${id}`,
    archived,
    archived_at: archived ? "2026-02-01T00:00:00Z" : null,
    favorite: false,
    favorited_at: null,
    created_at: "2026-01-01T00:00:00Z",
    merge_mode: null,
    herdr_session_name: "repo-abcd1234",
  };
}

function renderPage(handlers: Parameters<typeof mockRpcFetch>[0]) {
  vi.stubGlobal("fetch", mockRpcFetch(handlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => null,
  });
  const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/workflows",
    component: () => null,
  });
  const repositoriesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/repositories",
    component: RepositoriesPage,
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      settingsRoute,
      workflowsRoute,
      repositoriesRoute,
      repoRoute,
    ]),
    history: createMemoryHistory({
      initialEntries: ["/settings/repositories"],
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("RepositoriesPage", () => {
  it("lists active and archived repositories under Settings", async () => {
    renderPage({
      "repos/list": (p) =>
        p.archived === "archived"
          ? [repo("me/old", 3, true)]
          : [repo("me/alpha", 1)],
    });

    expect(
      await screen.findByRole("heading", { name: "Repositories" }),
    ).toBeTruthy();
    const settingsNav = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(settingsNav)
        .getByRole("link", { name: "Repositories" })
        .getAttribute("href"),
    ).toBe("/settings/repositories");

    expect(
      (await screen.findByText("me/alpha")).closest("a")?.getAttribute("href"),
    ).toBe("/r/me/alpha");
    expect(
      (await screen.findByText("me/old")).closest("a")?.getAttribute("href"),
    ).toBe("/r/me/old");
  });

  it("registers a repository from the add dialog", async () => {
    renderPage({
      "repos/list": () => [],
      "repos/create": (p) => repo(p.name, 4),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Add repository" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Add repository",
    });
    fireEvent.change(screen.getByLabelText("Local path"), {
      target: { value: "/work/app" },
    });
    fireEvent.change(screen.getByLabelText("Repository name"), {
      target: { value: "me/app" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add repository" }),
    );

    await waitFor(() => {
      expect(rpcCall("repos/create")?.params).toMatchObject({
        path: "/work/app",
        name: "me/app",
      });
    });
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it("dismisses the add dialog with Escape and backdrop click", async () => {
    renderPage({ "repos/list": () => [] });

    fireEvent.click(
      await screen.findByRole("button", { name: "Add repository" }),
    );
    let dialog = await screen.findByRole("dialog", { name: "Add repository" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(dialog.isConnected).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    dialog = await screen.findByRole("dialog", { name: "Add repository" });
    fireEvent.click(dialog.parentElement!);
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });
});
