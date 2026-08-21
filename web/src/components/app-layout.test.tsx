import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
vi.mock("@/queries/worker-status", () => ({
  useWorkerLaunchGate: () => ({
    data: {
      status: "compatible",
      required_protocol_version: 1,
      observed_protocol_version: 1,
      started_at: "2026-08-02T00:00:00Z",
      heartbeat_at: "2026-08-02T00:00:01Z",
    },
    isError: false,
    showRemediation: false,
  }),
}));

vi.mock("@/components/app-statusbar", () => ({
  AppStatusbar: ({ debugPanel }: { debugPanel?: React.ReactNode }) => (
    <footer data-testid="app-statusbar">
      Status
      {debugPanel}
    </footer>
  ),
}));
vi.mock("@/components/app-topbar", () => ({
  AppTopbar: () => <header>Topbar</header>,
}));
vi.mock("@/components/notification-stack", () => ({
  NotificationStack: () => (
    <aside data-testid="notification-stack">Notifications</aside>
  ),
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
vi.mock("@/lib/use-notification-sound", () => ({
  useNotificationSound: vi.fn(),
}));
vi.mock("@/lib/use-scroll-to-top", () => ({ useScrollToTop: vi.fn() }));
vi.mock("@/lib/web-config", () => ({
  useWebConfig: () => ({ debug: true }),
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
    // relative + overflow-hidden: contain absolute descendants (sr-only labels) so
    // they cannot expand document scrollHeight and create a second scrollbar.
    expect(shell?.className).toContain("relative");
    expect(main?.className).toContain("overflow-y-auto");
    expect(main?.contains(statusbar)).toBe(false);
    expect(statusbar.compareDocumentPosition(main as Node)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
  });

  it("places the open debug panel after main content in the shell flow", async () => {
    const { container } = renderLayout();
    await screen.findByText("Dashboard route");

    fireEvent.click(screen.getByRole("button", { name: "Debug panel" }));

    const main = container.querySelector("main");
    const panel = screen.getByTestId("debug-log-panel");
    expect(main?.compareDocumentPosition(panel)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(panel.parentElement?.className).toContain("flex");
    expect(panel.parentElement?.className).toContain("flex-col");
    expect(panel.className).toContain("shrink-0");
  });

  it("reserves the detail pages' sticky header height as scroll padding (#2033)", async () => {
    const { container } = renderLayout();
    await screen.findByText("Dashboard route");

    // Must match DetailStickyHeader's bar height (h-11), so an anchor jump inside the scroll
    // area lands below the bar instead of underneath it.
    expect(container.querySelector("main")?.className).toContain(
      "scroll-pt-11",
    );
  });

  // #2414: without a positioned shell, below-the-fold Tailwind sr-only labels
  // (position:absolute) expand document scrollHeight and paint a second vertical
  // scrollbar beside main. relative + overflow-hidden keeps one scrollport.
  it("positions the shell so absolute descendants cannot create a document scrollbar (#2414)", async () => {
    const { container } = renderLayout();
    await screen.findByText("Dashboard route");

    const shell = container.firstElementChild;
    expect(shell?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["relative", "h-screen", "overflow-hidden"]),
    );
    expect(container.querySelector("main")?.className).toContain(
      "overflow-y-auto",
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

  it("keeps the notification stack mounted across all routes", async () => {
    const { router } = renderLayout();
    await screen.findByText("Dashboard route");
    const stack = screen.getByTestId("notification-stack");

    await act(() => router.navigate({ to: "/settings" }));
    await screen.findByText("Settings route");
    expect(screen.getByTestId("notification-stack")).toBe(stack);

    await act(() =>
      router.navigate({
        to: "/r/$owner/$repo/issues/$number",
        params: { owner: "me", repo: "proj", number: "12" },
      }),
    );
    await screen.findByText("Issue route");
    expect(screen.getByTestId("notification-stack")).toBe(stack);
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
