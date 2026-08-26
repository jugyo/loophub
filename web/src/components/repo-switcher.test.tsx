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
import { afterEach, describe, expect, it, vi } from "#loophub-test";
import type { Repo } from "@/api/types";
import { RepoSwitcher } from "./repo-switcher";

const reposData = vi.hoisted(() => ({
  value: [] as Repo[],
  isError: false,
}));
const favoriteMutations = vi.hoisted(() => ({
  calls: [] as Array<{ owner: string; repo: string; favorite: boolean }>,
  pending: new Set<string>(),
}));

vi.mock("@/queries/repos", () => ({
  useRepos: () => ({
    data: reposData.value,
    isLoading: false,
    isError: reposData.isError,
  }),
  useSetRepoFavorite: (owner: string, repoName: string) => ({
    isPending: favoriteMutations.pending.has(`${owner}/${repoName}`),
    mutate: (favorite: boolean) => {
      favoriteMutations.calls.push({ owner, repo: repoName, favorite });
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  reposData.value = [];
  reposData.isError = false;
  favoriteMutations.calls = [];
  favoriteMutations.pending.clear();
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
    herdr_session_name: "repo-abcd1234",
    ...overrides,
  };
}

function renderInRouter(openRequest = 1) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <RepoSwitcher openRequest={openRequest} />
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
  it("does not open with Cmd/Ctrl+K", async () => {
    renderInRouter(0);
    await screen.findByText("ready");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores vim keys for selection movement", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({ id: 2, name: "beta", full_name: "me/beta" }),
    ];
    const router = renderInRouter();
    await screen.findByText("ready");

    const dialog = await screen.findByRole("dialog", {
      name: "Switch repository",
    });

    fireEvent.keyDown(dialog, { key: "j" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/me/alpha"),
    );
  });

  it("moves selection with arrow keys and navigates to the selected repo", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({ id: 2, name: "beta", full_name: "me/beta" }),
    ];
    const router = renderInRouter();
    await screen.findByText("ready");

    const dialog = await screen.findByRole("dialog", {
      name: "Switch repository",
    });
    const filter = screen.getByRole("searchbox", {
      name: "Filter repositories",
    });
    expect(filter.getAttribute("aria-describedby")).toBe(
      "repo-switcher-active",
    );
    expect(screen.getByText("Selected repository: me/alpha")).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(screen.getByText("Selected repository: me/beta")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Enter" });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/me/beta"),
    );
  });

  it("does not navigate when Enter confirms IME composition in the filter", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
    ];
    const router = renderInRouter();
    await screen.findByText("ready");

    const filter = await screen.findByRole("searchbox", {
      name: "Filter repositories",
    });

    fireEvent.keyDown(filter, { key: "Enter", isComposing: true });

    expect(router.state.location.pathname).toBe("/");
  });

  it("filters repository candidates by keyword", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({ id: 2, name: "beta", full_name: "team/beta" }),
      makeRepo({ id: 3, name: "gamma", full_name: "org/gamma" }),
    ];
    renderInRouter();
    await screen.findByText("ready");

    const filter = await screen.findByRole("searchbox", {
      name: "Filter repositories",
    });

    fireEvent.change(filter, { target: { value: "team" } });

    expect(screen.queryByText("me/alpha")).toBeNull();
    expect(screen.getByText("team/beta")).toBeTruthy();
    expect(screen.queryByText("org/gamma")).toBeNull();
  });

  it("renders repository candidates as links", async () => {
    reposData.value = [makeRepo({ id: 1, full_name: "me/alpha" })];
    renderInRouter();
    await screen.findByText("ready");

    const link = await screen.findByRole("link", { name: "me/alpha" });

    expect(link.getAttribute("href")).toBe("/r/me/alpha");
  });

  it("Unicode を含む repository 名を dashboard と同じ順序で並べる", async () => {
    reposData.value = [
      makeRepo({ id: 1, full_name: "a/z" }),
      makeRepo({ id: 2, full_name: "Ä/alpha" }),
      makeRepo({ id: 3, full_name: "e/z" }),
      makeRepo({ id: 4, full_name: "É/alpha" }),
      makeRepo({ id: 5, full_name: "z/favorite", favorite: true }),
    ];
    renderInRouter();
    await screen.findByText("ready");

    const repositoryList = await screen.findByRole("list", {
      name: "Repositories",
    });
    const order = within(repositoryList)
      .getAllByRole("link")
      .map((link) => link.textContent?.trim());

    expect(order).toEqual(["z/favorite", "Ä/alpha", "a/z", "É/alpha", "e/z"]);
  });

  it("keeps the picker open for modified clicks on filtered repositories", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({ id: 2, name: "beta", full_name: "team/beta" }),
    ];
    const router = renderInRouter();
    await screen.findByText("ready");

    const filter = await screen.findByRole("searchbox", {
      name: "Filter repositories",
    });
    fireEvent.change(filter, { target: { value: "team" } });

    const link = await screen.findByRole("link", { name: "team/beta" });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { shiftKey: true });

    expect(router.state.location.pathname).toBe("/");
    expect(
      screen.getByRole("dialog", { name: "Switch repository" }),
    ).toBeTruthy();
  });

  it("navigates and closes the picker on a normal repository link click", async () => {
    reposData.value = [makeRepo({ id: 1, full_name: "me/alpha" })];
    const router = renderInRouter();
    await screen.findByText("ready");

    fireEvent.click(await screen.findByRole("link", { name: "me/alpha" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/me/alpha"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not expose an ARIA listbox around rows with a link and a button", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
    ];
    renderInRouter();
    await screen.findByText("ready");

    expect(await screen.findByRole("link", { name: "me/alpha" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "me/alpha" }).className).toContain(
      "focus-visible:ring-1",
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("keeps keyboard navigation inert when no repositories are available", async () => {
    reposData.value = [];
    const router = renderInRouter();
    await screen.findByText("ready");

    const dialog = await screen.findByRole("dialog", {
      name: "Switch repository",
    });

    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(screen.getByText("No repositories.")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps cached repository choices available after a background refresh error", async () => {
    reposData.value = [makeRepo({ id: 1, full_name: "me/alpha" })];
    reposData.isError = true;
    renderInRouter();
    await screen.findByText("ready");

    expect(await screen.findByText("me/alpha")).toBeTruthy();
    expect(screen.queryByText("Failed to load repositories.")).toBeNull();
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

    const dialog = await screen.findByRole("dialog", {
      name: "Switch repository",
    });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();

    fireEvent.keyDown(dialog, { key: "ArrowDown" });

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }),
    );
  });

  it("uses the same favorite star affordance as the topbar menu", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({
        id: 2,
        name: "beta",
        full_name: "me/beta",
        favorite: true,
      }),
    ];
    renderInRouter();
    await screen.findByText("ready");

    const addFavoriteButton = await screen.findByRole("button", {
      name: "Add to favorites: me/alpha",
    });
    expect(addFavoriteButton.className).toContain("opacity-0");
    expect(addFavoriteButton.className).toContain("group-hover:opacity-100");
    expect(
      screen
        .getByRole("button", { name: "Remove from favorites: me/beta" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(addFavoriteButton);

    expect(favoriteMutations.calls).toEqual([
      { owner: "me", repo: "alpha", favorite: true },
    ]);
  });

  it("does not expose enabled hover visibility on pending favorite buttons", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({
        id: 2,
        name: "beta",
        full_name: "me/beta",
        favorite: true,
      }),
    ];
    favoriteMutations.pending.add("me/alpha");
    favoriteMutations.pending.add("me/beta");
    renderInRouter();
    await screen.findByText("ready");

    const addFavoriteButton = await screen.findByRole("button", {
      name: "Add to favorites: me/alpha",
    });
    expect((addFavoriteButton as HTMLButtonElement).disabled).toBe(true);
    expect(addFavoriteButton.className).toContain("opacity-60");
    expect(addFavoriteButton.className).not.toContain(
      "group-hover:opacity-100",
    );
    expect(addFavoriteButton.className).not.toContain(
      "group-focus-within:opacity-100",
    );

    const removeFavoriteButton = screen.getByRole("button", {
      name: "Remove from favorites: me/beta",
    });
    expect((removeFavoriteButton as HTMLButtonElement).disabled).toBe(true);
    expect(removeFavoriteButton.className).toContain(
      "disabled:hover:text-yellow-600",
    );
    expect(removeFavoriteButton.className).not.toContain(
      "hover:text-yellow-700",
    );
    expect(removeFavoriteButton.className).not.toContain(
      "dark:hover:text-yellow-200",
    );
  });

  it("does not navigate when the favorite star is activated from the keyboard", async () => {
    reposData.value = [
      makeRepo({ id: 1, name: "alpha", full_name: "me/alpha" }),
      makeRepo({ id: 2, name: "beta", full_name: "me/beta" }),
    ];
    const router = renderInRouter();
    await screen.findByText("ready");

    const favoriteButton = await screen.findByRole("button", {
      name: "Add to favorites: me/alpha",
    });

    fireEvent.keyDown(favoriteButton, { key: "Enter" });
    fireEvent.click(favoriteButton);

    expect(favoriteMutations.calls).toEqual([
      { owner: "me", repo: "alpha", favorite: true },
    ]);
    expect(router.state.location.pathname).toBe("/");
  });

  it("does not run repository selection when Enter is pressed on the close button", async () => {
    reposData.value = [makeRepo({ id: 1, full_name: "me/alpha" })];
    const router = renderInRouter();
    await screen.findByText("ready");

    const closeButton = await screen.findByRole("button", {
      name: "Close repository switcher",
    });

    fireEvent.keyDown(closeButton, { key: "Enter" });

    expect(router.state.location.pathname).toBe("/");
  });
});
