import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
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
import type { HerdrRepoSessions, Notification } from "@/api/types";
import { NotificationStack } from "./notification-stack";

const notifications = vi.hoisted(() => ({
  value: [] as Notification[],
  isError: false,
  herdrRepos: [] as HerdrRepoSessions[],
}));
const actions = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  readAll: vi.fn(),
  focus: vi.fn(),
  showError: vi.fn(),
}));

vi.mock("@/queries/notifications", () => ({
  useNotifications: (input: unknown) => {
    actions.list(input);
    return { data: notifications.value, isError: notifications.isError };
  },
  useReadNotification: () => ({ mutate: actions.read }),
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
  vi.clearAllMocks();
  notifications.value = [];
  notifications.isError = false;
  notifications.herdrRepos = [];
});

function makeNotification(
  id: number,
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id,
    kind: "merge_ready",
    severity: "info",
    repo: { name: "me/proj" },
    title: `Notification ${id}`,
    body: `Body ${id}`,
    resource: {
      kind: "pull",
      number: id,
      title: null,
      href: `/r/me/proj/pulls/${id}`,
    },
    herdr_pane_id: null,
    read_at: null,
    created_at: `2026-01-01T00:00:0${id}Z`,
    ...overrides,
  };
}

function renderStack() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <NotificationStack />
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

describe("NotificationStack", () => {
  it("keeps notification loading errors visible", async () => {
    notifications.isError = true;

    renderStack();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to load notifications.",
    );
  });

  it("shows only the five newest unread notifications", async () => {
    notifications.value = [
      makeNotification(2),
      makeNotification(6),
      makeNotification(1),
      makeNotification(4),
      makeNotification(7, { read_at: "2026-01-01T00:01:00Z" }),
      makeNotification(3),
      makeNotification(5),
    ];

    renderStack();

    const stack = await screen.findByRole("region", {
      name: "Unread notifications",
    });
    expect(stack.className).toContain("fixed");
    expect(actions.list).toHaveBeenCalledWith({ unreadOnly: true });
    expect(screen.queryByText("Notification 1")).toBeNull();
    expect(screen.queryByText("Notification 7")).toBeNull();
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      [
        expect.stringContaining("Notification 6"),
        expect.stringContaining("Notification 5"),
        expect.stringContaining("Notification 4"),
        expect.stringContaining("Notification 3"),
        expect.stringContaining("Notification 2"),
      ],
    );
  });

  it("renders notification kinds and warning severity with distinct tones", async () => {
    notifications.value = [
      makeNotification(1, { kind: "merge_ready" }),
      makeNotification(2, { kind: "over_budget", severity: "warning" }),
      makeNotification(3, { kind: "human_attention" }),
    ];

    renderStack();
    await screen.findByRole("link", { name: /Notification 1/ });

    function iconFor(id: number): SVGSVGElement {
      const link = screen.getByRole("link", {
        name: new RegExp(`Notification ${id}`),
      });
      const icon = link.parentElement?.querySelector("svg");
      if (!icon) throw new Error(`no icon for Notification ${id}`);
      return icon as SVGSVGElement;
    }

    const mergeReady = iconFor(1);
    expect(mergeReady.classList).toContain("lucide-circle-check");
    expect(mergeReady.getAttribute("class")).toContain("text-emerald-700");

    const overBudget = iconFor(2);
    expect(overBudget.classList).toContain("lucide-triangle-alert");
    expect(overBudget.getAttribute("class")).toContain("text-amber-700");
    expect(overBudget.closest("article")?.dataset.severity).toBe("warning");

    const humanAttention = iconFor(3);
    expect(humanAttention.classList).toContain("lucide-info");
    expect(humanAttention.getAttribute("class")).toContain("text-sky-700");
    expect(humanAttention.classList).not.toContain("lucide-triangle-alert");
    expect(humanAttention.getAttribute("class")).not.toContain("text-rose-700");
  });

  it("reveals the next older unread notification after closing a newer one", async () => {
    notifications.value = [1, 2, 3, 4, 5, 6].map((id) => makeNotification(id));
    renderStack();

    expect(screen.queryByText("Notification 1")).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Close Notification 6" }),
    );

    expect(actions.read).toHaveBeenCalledWith(6, expect.any(Object));
    expect(screen.queryByText("Notification 6")).toBeNull();
    expect(screen.getByText("Notification 1")).toBeTruthy();
  });

  it("marks every unread notification read through Clear all", async () => {
    notifications.value = [makeNotification(1), makeNotification(2)];
    renderStack();

    fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));

    expect(actions.readAll).toHaveBeenCalledWith(undefined, expect.any(Object));
  });

  it("navigates pull notifications and marks them read", async () => {
    notifications.value = [makeNotification(12)];
    const { router } = renderStack();

    const link = await screen.findByRole("link", { name: /Notification 12/ });
    await act(async () => fireEvent.click(link));

    expect(actions.read).toHaveBeenCalledWith(12, expect.any(Object));
    expect(router.state.location.pathname).toBe("/r/me/proj/pulls/12");
  });

  it("shows a pull title on one truncated line", async () => {
    const title = "A very long pull request title that should stay on one line";
    notifications.value = [
      makeNotification(12, {
        resource: {
          kind: "pull",
          number: 12,
          title,
          href: "/r/me/proj/pulls/12",
        },
      }),
    ];

    renderStack();

    const titleElement = await screen.findByText(title);
    expect(titleElement.className).toContain("truncate");
    expect(titleElement.className).toContain("text-xs");
  });

  it("does not reserve space for a missing pull title", async () => {
    notifications.value = [
      makeNotification(12, {
        resource: {
          kind: "pull",
          number: 12,
          title: null,
          href: "/r/me/proj/pulls/12",
        },
      }),
    ];

    renderStack();

    expect(await screen.findByText("Notification 12")).toBeTruthy();
    expect(screen.queryByText("A very long pull request title")).toBeNull();
  });

  it("shows and focuses a live Herdr pane for the notification PR", async () => {
    notifications.value = [makeNotification(12)];
    notifications.herdrRepos = [
      {
        repo: "me/proj",
        session_name: "me/proj",
        agents: [],
        pull_workspaces: [
          { pull: 12, pane_id: "pane_live_1234567890", status: "working" },
        ],
        issue_workspaces: [],
      },
    ];
    const { router } = renderStack();

    const openButton = await screen.findByRole("button", {
      name: "Open PR #12 in Herdr",
    });
    expect(openButton.querySelector("svg.lucide-terminal")).toBeTruthy();
    fireEvent.click(openButton);

    expect(actions.focus).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "pane_live_1234567890" },
      expect.any(Object),
    );
    expect(actions.read).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/");
  });

  it("places the Herdr action at the bottom-right away from close", async () => {
    notifications.value = [makeNotification(12)];
    notifications.herdrRepos = [
      {
        repo: "me/proj",
        session_name: "me/proj",
        agents: [],
        pull_workspaces: [
          { pull: 12, pane_id: "pane_live_1234567890", status: "working" },
        ],
        issue_workspaces: [],
      },
    ];
    renderStack();

    const closeButton = await screen.findByRole("button", {
      name: "Close Notification 12",
    });
    const openButton = screen.getByRole("button", {
      name: "Open PR #12 in Herdr",
    });
    const actions = closeButton.parentElement;

    expect(actions).toBe(openButton.parentElement);
    expect(actions?.className).toContain("self-stretch");
    expect(actions?.className).toContain("justify-between");
  });

  it("hides the Herdr action when the stored pane is no longer live", async () => {
    notifications.value = [
      makeNotification(12, { herdr_pane_id: "pane_stale_1234567890" }),
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
    renderStack();

    expect(
      await screen.findByRole("button", { name: "Close Notification 12" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open PR #12 in Herdr" }),
    ).toBeNull();
  });

  it.each([
    {
      action: "read",
      invoke: async () => {
        fireEvent.click(
          await screen.findByRole("button", { name: "Close Notification 12" }),
        );
      },
      message: "Read failed",
    },
    {
      action: "readAll",
      invoke: async () => {
        fireEvent.click(
          await screen.findByRole("button", { name: "Clear all" }),
        );
      },
      message: "Clear failed",
    },
    {
      action: "focus",
      invoke: async () => {
        fireEvent.click(
          await screen.findByRole("button", { name: "Open PR #12 in Herdr" }),
        );
      },
      message: "Focus failed",
    },
  ])("shows $action failures through the shared error toast", async (testCase) => {
    notifications.value = [makeNotification(12)];
    notifications.herdrRepos = [
      {
        repo: "me/proj",
        session_name: "me/proj",
        agents: [],
        pull_workspaces: [
          { pull: 12, pane_id: "pane_live_1234567890", status: "working" },
        ],
        issue_workspaces: [],
      },
    ];
    actions[
      testCase.action as "read" | "readAll" | "focus"
    ].mockImplementationOnce(
      (_input: unknown, options: { onError: (error: Error) => void }) =>
        options.onError(new Error(testCase.message)),
    );
    renderStack();

    await testCase.invoke();

    expect(actions.showError).toHaveBeenCalledWith(testCase.message);
  });
});
