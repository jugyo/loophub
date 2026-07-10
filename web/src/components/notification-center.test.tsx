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
import type { HerdrRepoSessions, Notification } from "@/api/types";
import { NotificationCenter } from "./notification-center";

const notifications = vi.hoisted(() => ({
  value: [] as Notification[],
  isLoading: false,
  isError: false,
  unread: 0,
  herdrRepos: [] as HerdrRepoSessions[],
}));
const actions = vi.hoisted(() => ({
  read: vi.fn(),
  readAll: vi.fn(),
  focus: vi.fn(),
  showError: vi.fn(),
}));

vi.mock("@/queries/notifications", () => ({
  useNotifications: () => ({
    data: notifications.value,
    isLoading: notifications.isLoading,
    isError: notifications.isError,
  }),
  useUnreadNotificationCount: () => ({ data: { count: notifications.unread } }),
  useReadNotification: () => ({ mutate: actions.read, isPending: false }),
  useReadAllNotifications: () => ({
    mutate: actions.readAll,
    isPending: false,
  }),
}));

vi.mock("@/queries/terminal", () => ({
  useFocusHerdrAgent: () => ({ mutate: actions.focus, isPending: false }),
  useHerdrSessions: () => ({ data: { repos: notifications.herdrRepos } }),
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError: actions.showError }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  notifications.value = [];
  notifications.isLoading = false;
  notifications.isError = false;
  notifications.unread = 0;
  notifications.herdrRepos = [];
});

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    kind: "merge_ready",
    repo: { name: "me/proj" },
    title: "Ready to merge",
    body: "PR #12 in me/proj is ready to merge.",
    resource: { kind: "pull", number: 12, href: "/r/me/proj/pulls/12" },
    herdr_pane_id: null,
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderCenter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <NotificationCenter />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("NotificationCenter", () => {
  it("opens notifications and marks the main item read when navigating", async () => {
    notifications.value = [makeNotification()];
    notifications.unread = 1;
    const { router } = renderCenter();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: /1 unread/ }),
      {
        button: 0,
        ctrlKey: false,
      },
    );
    const link = await screen.findByRole("link", {
      name: /Ready to merge/,
    });
    fireEvent.click(link);

    expect(actions.read).toHaveBeenCalledWith(1, expect.any(Object));
    expect(router.state.location.pathname).toBe("/r/me/proj/pulls/12");
    expect(screen.queryByText("Ready to merge")).toBeNull();
  });

  it("marks one notification read without navigating", async () => {
    notifications.value = [makeNotification()];
    notifications.unread = 1;
    actions.read.mockImplementationOnce(() => {
      notifications.value = [
        makeNotification({ read_at: "2026-01-01T00:00:10Z" }),
      ];
      notifications.unread = 0;
    });
    const { router } = renderCenter();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: /1 unread/ }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Mark PR #12 as read" }),
    );

    expect(actions.read).toHaveBeenCalledWith(1, expect.any(Object));
    expect(router.state.location.pathname).toBe("/");

    expect(screen.queryByLabelText("Unread")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Mark .* as read/ }),
    ).toBeNull();
    expect(
      document.querySelector('button[aria-label="Notifications"]'),
    ).toBeTruthy();
    expect(screen.getByText("Ready to merge")).toBeTruthy();
  });

  it("focuses Herdr without triggering notification navigation or read", async () => {
    notifications.value = [
      makeNotification({ herdr_pane_id: "pane_1234567890abcdef" }),
    ];
    notifications.herdrRepos = [
      {
        repo: "me/proj",
        session_name: "me/proj",
        agents: [
          {
            id: "pane_1234567890abcdef",
            name: "dev #12",
            status: "working",
          },
        ],
        pull_workspaces: [],
        issue_workspaces: [],
      },
    ];
    notifications.unread = 1;
    const { router } = renderCenter();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: /1 unread/ }),
      {
        button: 0,
        ctrlKey: false,
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: /Open PR #12/ }));

    expect(actions.focus).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "pane_1234567890abcdef" },
      expect.any(Object),
    );
    expect(actions.read).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/");
  });

  it("shows Herdr action for generated PR notifications with a live workspace", async () => {
    notifications.value = [makeNotification()];
    notifications.herdrRepos = [
      {
        session_name: "me/proj",
        repo: "me/proj",
        agents: [],
        pull_workspaces: [
          { pull: 12, pane_id: "pane_live_1234567890", status: "working" },
        ],
        issue_workspaces: [],
      },
    ];
    renderCenter();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Notifications" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: /Open PR #12/ }));

    expect(actions.focus).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "pane_live_1234567890" },
      expect.any(Object),
    );
  });

  it("hides Herdr action when a stored pane id is stale", async () => {
    notifications.value = [
      makeNotification({ herdr_pane_id: "pane_stale_1234567890" }),
    ];
    notifications.herdrRepos = [
      {
        repo: "me/proj",
        session_name: "me/proj",
        agents: [],
        pull_workspaces: [],
        issue_workspaces: [],
      },
    ];
    renderCenter();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Notifications" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );

    expect(screen.queryByRole("button", { name: /Open PR #12/ })).toBeNull();
  });

  it("hides read notifications unless they are in the local grace window", async () => {
    notifications.value = [
      makeNotification({ id: 2, read_at: "2026-01-01T00:00:10Z" }),
    ];
    renderCenter();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Notifications" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );

    expect(await screen.findByText("No notifications.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Mark .* as read/ }),
    ).toBeNull();
  });

  it("clears all visible notifications via the Clear all button", async () => {
    actions.readAll.mockReset();
    notifications.value = [
      makeNotification({ id: 1 }),
      makeNotification({
        id: 2,
        resource: { kind: "repo", number: null, href: "/r/me/proj" },
      }),
    ];
    notifications.unread = 2;
    renderCenter();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: /2 unread/ }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));

    expect(actions.readAll).toHaveBeenCalledTimes(1);
  });

  it("disables Clear all when there are no visible notifications", async () => {
    actions.readAll.mockReset();
    notifications.value = [];
    renderCenter();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Notifications" }),
      { button: 0, ctrlKey: false },
    );
    const clearAll = await screen.findByRole("button", { name: "Clear all" });
    expect((clearAll as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(clearAll);
    expect(actions.readAll).not.toHaveBeenCalled();
  });
});
