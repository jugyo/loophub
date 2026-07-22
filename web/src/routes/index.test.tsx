import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
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
import { HomePage } from "./index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function repo(full_name: string, id: number): Repo {
  return {
    id,
    name: full_name.split("/")[1],
    full_name,
    owner: { login: full_name.split("/")[0] },
    default_branch: "main",
    local_path: `/tmp/${id}`,
    archived: false,
    archived_at: null,
    favorite: false,
    favorited_at: null,
    created_at: "2026-01-01T00:00:00Z",
    merge_mode: null,
    herdr_session_name: "repo-abcd1234",
  };
}

function renderHome() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: HomePage,
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
    routeTree: rootRoute.addChildren([indexRoute, archivedRoute, repoRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("HomePage", () => {
  it("uses Home as the active repository list with archived and add entry points", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/list": () => [repo("me/alpha", 1), repo("me/beta", 2)],
      }),
    );

    renderHome();

    expect(
      await screen.findByRole("heading", { name: "Repositories" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Recent issues" })).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Archived repositories" })
        .getAttribute("href"),
    ).toBe("/archived");
    expect(screen.getByRole("button", { name: "Add repository" })).toBeTruthy();
    expect(
      screen.getByText("me/alpha").closest("a")?.getAttribute("href"),
    ).toBe("/r/me/alpha");
  });

  it("registers a repository from the Home add dialog", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/list": () => [],
        "repos/create": (p) => repo(p.name, 3),
      }),
    );

    renderHome();

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

  it("dismisses the Home add dialog with Escape and backdrop click", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/list": () => [],
      }),
    );

    renderHome();

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
