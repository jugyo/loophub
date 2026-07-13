import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./app-layout";

vi.mock("@/queries/repos", () => ({
  useRepos: () => ({
    data: [
      {
        full_name: "me/proj",
        herdr_session_name: "me-proj-abcd1234",
      },
    ],
  }),
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({
    data: { repos: [], running_repos: [] },
    isError: false,
  }),
}));

vi.mock("@/components/app-statusbar", () => ({
  AppStatusbar: () => <footer data-testid="app-statusbar">Status</footer>,
}));
vi.mock("@/components/app-topbar", () => ({
  AppTopbar: () => <header>Topbar</header>,
}));
vi.mock("@/components/repo-topbar", () => ({
  RepoTopbar: () => <nav>Repo topbar</nav>,
}));
vi.mock("@/components/repo-switcher", () => ({
  RepoSwitcher: () => null,
}));
vi.mock("@/components/terminal-controller", () => ({
  TerminalControllerProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  TerminalLaunchErrorDialog: () => null,
}));
vi.mock("@/components/toast", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  ToastViewport: () => null,
}));
vi.mock("@/lib/use-scroll-to-top", () => ({ useScrollToTop: vi.fn() }));
vi.mock("@/lib/use-issue-keyboard-navigation", () => ({
  useIssueKeyboardNavigation: vi.fn(),
}));

afterEach(cleanup);

function renderLayout(initialPath = "/") {
  const rootRoute = createRootRoute({ component: AppLayout });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>Dashboard route</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div>Settings route</div>,
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => <div>Repo route</div>,
  });
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => <div>Issue route</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      settingsRoute,
      repoRoute,
      issueRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("AppLayout", () => {
  it("keeps the global status bar outside the route content scroll area", async () => {
    const { container } = renderLayout();
    await screen.findByText("Dashboard route");

    const shell = container.firstElementChild;
    const main = container.querySelector("main");
    const statusbar = screen.getByTestId("app-statusbar");
    expect(shell?.className).toContain("h-screen");
    expect(shell?.className).toContain("overflow-hidden");
    expect(main?.className).toContain("overflow-y-auto");
    expect(main?.contains(statusbar)).toBe(false);
    expect(statusbar.compareDocumentPosition(main as Node)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
  });

  it("keeps the same status bar mounted across routes", async () => {
    const { router } = renderLayout();
    await screen.findByText("Dashboard route");
    const statusbar = screen.getByTestId("app-statusbar");

    await act(() => router.navigate({ to: "/settings" }));
    await screen.findByText("Settings route");

    expect(screen.getByTestId("app-statusbar")).toBe(statusbar);
  });

  it("shows the shared repo warning on repo top and issue detail routes", async () => {
    const { router } = renderLayout("/r/me/proj");
    await screen.findByText("Repo route");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("herdr --session me-proj-abcd1234")).toBeTruthy();

    await act(() =>
      router.navigate({
        to: "/r/$owner/$repo/issues/$number",
        params: { owner: "me", repo: "proj", number: "12" },
      }),
    );
    await screen.findByText("Issue route");
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
