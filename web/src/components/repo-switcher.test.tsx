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
import { RepoSwitcher } from "./repo-switcher";

const reposData = vi.hoisted(() => ({
  value: [] as Repo[],
}));

vi.mock("@/queries/repos", () => ({
  useRepos: () => ({
    data: reposData.value,
    isLoading: false,
    isError: false,
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  reposData.value = [];
});

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    id: 1,
    name: "repo",
    full_name: "me/repo",
    owner: { login: "me" },
    default_branch: "main",
    local_path: "/tmp/repo",
    created_at: "2026-01-01T00:00:00Z",
    archived: false,
    archived_at: null,
    favorite: false,
    favorited_at: null,
    merge_mode: null,
    ...overrides,
  };
}

function renderInRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <RepoSwitcher />
        <span>ready</span>
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
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
  render(<RouterProvider router={router} />);
  return router;
}

describe("RepoSwitcher", () => {
  it("opens with Cmd+K and navigates to the selected repo with vim keys", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({ id: 2, name: "beta", full_name: "me/beta" }),
    ];
    const router = renderInRouter();
    await screen.findByText("ready");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", {
      name: "Switch repository",
    });

    fireEvent.keyDown(dialog, { key: "j" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/me/beta"),
    );
  });

  it("does not open from Cmd+K inside a text input", () => {
    renderInRouter();
    render(<input aria-label="name" />);
    const input = screen.getByLabelText("name");
    input.focus();

    fireEvent.keyDown(input, { key: "k", metaKey: true });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open over an existing modal dialog", () => {
    renderInRouter();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    button.textContent = "Existing dialog action";
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();

    fireEvent.keyDown(button, { key: "k", metaKey: true });

    expect(
      screen.queryByRole("dialog", { name: "Switch repository" }),
    ).toBeNull();
    dialog.remove();
  });

  it("keeps keyboard navigation inert when no repositories are available", async () => {
    reposData.value = [];
    const router = renderInRouter();
    await screen.findByText("ready");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", {
      name: "Switch repository",
    });

    fireEvent.keyDown(dialog, { key: "j" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(screen.getByText("No repositories.")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps the active keyboard option scrolled into view", async () => {
    const scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView,
    );
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({ id: 2, name: "beta", full_name: "me/beta" }),
      makeRepo({ id: 3, name: "gamma", full_name: "me/gamma" }),
    ];
    renderInRouter();
    await screen.findByText("ready");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", {
      name: "Switch repository",
    });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();

    fireEvent.keyDown(dialog, { key: "j" });

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }),
    );
  });
});
