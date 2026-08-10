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
import type {
  HerdrRepoSessions,
  Notification,
  WorkflowRunState,
} from "@/api/types";
import { NotificationStack } from "./notification-stack";

const notifications = vi.hoisted(() => ({
  value: [] as Notification[],
  isError: false,
  herdrRepos: [] as HerdrRepoSessions[],
  workflowRun: null as WorkflowRunState | null,
  // Subscribers stand in for the query cache, so a test can deliver a notification to a
  // mounted stack the way an invalidated list would.
  listeners: new Set<() => void>(),
}));
const actions = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  readAll: vi.fn(),
  focus: vi.fn(),
  showError: vi.fn(),
  increaseCostLimit: vi.fn(),
}));

vi.mock("@/queries/notifications", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useNotifications: (input: unknown) => {
      actions.list(input);
      useSyncExternalStore(
        (onChange: () => void) => {
          notifications.listeners.add(onChange);
          return () => notifications.listeners.delete(onChange);
        },
        () => notifications.value,
      );
      return { data: notifications.value, isError: notifications.isError };
    },
    useReadNotification: () => ({ mutate: actions.read }),
    useReadAllNotifications: () => ({
      mutate: actions.readAll,
      isPending: false,
    }),
  };
});

vi.mock("@/queries/terminal", () => ({
  useFocusHerdrAgent: () => ({ mutate: actions.focus, isPending: false }),
  useHerdrSessions: () => ({ data: { repos: notifications.herdrRepos } }),
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError: actions.showError }),
}));

vi.mock("@/queries/workflow-runs", () => ({
  useWorkflowRunForPull: () => ({ data: notifications.workflowRun }),
  useIncreaseWorkflowRunCostLimit: () => ({
    mutate: actions.increaseCostLimit,
    isPending: false,
  }),
}));

/** Replace the unread list the way a refreshed query would, notifying mounted stacks. */
function deliverNotifications(next: Notification[]) {
  notifications.value = next;
  act(() => {
    for (const listener of notifications.listeners) listener();
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  notifications.value = [];
  notifications.isError = false;
  notifications.herdrRepos = [];
  notifications.workflowRun = null;
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
    workflow_run_id: null,
    read_at: null,
    created_at: `2026-01-01T00:00:0${id}Z`,
    ...overrides,
  };
}

function makeCostNotification(
  overrides: Partial<Notification> = {},
): Notification {
  return makeNotification(12, {
    kind: "over_budget",
    severity: "warning",
    title: "Workflow cost limit exceeded",
    workflow_run_id: 7,
    ...overrides,
  });
}

function makeRunState(
  partial: Partial<WorkflowRunState> = {},
): WorkflowRunState {
  return {
    id: 7,
    workflow_id: 3,
    workflow_name: "standard",
    status: "running",
    current_step: "execute",
    rework_count: 0,
    rework_limit: 8,
    cost_increment_usd: 10,
    cost_limit_usd: 20,
    cost_limit_increase_available: true,
    needs_human_reason: "cost limit exceeded",
    issue_number: 42,
    pr_number: 12,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ended_at: null,
    latest_review: null,
    verification_status: "unverified",
    done: false,
    merge_conflict: false,
    ...partial,
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
      makeNotification(4, { kind: "agent_comment" }),
    ];

    renderStack();
    await screen.findByRole("link", { name: /Notification 1/ });

    function iconFor(id: number): SVGSVGElement {
      const link = screen.getByRole("link", {
        name: new RegExp(`Notification ${id}`),
      });
      const icon = link.closest("article")?.querySelector("svg");
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

    const agentComment = iconFor(4);
    expect(agentComment.classList).toContain("lucide-message-square");
    expect(agentComment.getAttribute("class")).toContain("text-violet-700");
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

  it("shows the increase question and increases a cost-held run's limit after Yes", async () => {
    notifications.value = [makeCostNotification()];
    notifications.workflowRun = makeRunState();
    renderStack();

    expect(
      await screen.findByRole("group", { name: "Increase to $30.00?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(actions.increaseCostLimit).toHaveBeenCalledWith(
      { run: 7, expectedLimitUsd: 20 },
      expect.any(Object),
    );
  });

  it("marks the notification read with No without increasing", async () => {
    notifications.value = [makeCostNotification()];
    notifications.workflowRun = makeRunState();
    renderStack();

    fireEvent.click(await screen.findByRole("button", { name: "No" }));

    expect(actions.increaseCostLimit).not.toHaveBeenCalled();
    expect(actions.read).toHaveBeenCalledWith(12, expect.any(Object));
    expect(screen.queryByText("Workflow cost limit exceeded")).toBeNull();
  });

  it.each([
    {
      case: "the run is not held on its limit",
      notification: makeCostNotification(),
      run: makeRunState({ cost_limit_increase_available: false }),
    },
    {
      case: "the PR moved on to another run",
      notification: makeCostNotification(),
      run: makeRunState({ id: 8 }),
    },
    {
      case: "the notification is not about a run",
      notification: makeCostNotification({ workflow_run_id: null }),
      run: makeRunState(),
    },
    {
      case: "the notification is not a budget one",
      notification: makeCostNotification({ kind: "human_attention" }),
      run: makeRunState(),
    },
  ])("offers no increase when $case", async (testCase) => {
    notifications.value = [testCase.notification];
    notifications.workflowRun = testCase.run;
    renderStack();

    expect(
      await screen.findByText("Workflow cost limit exceeded"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: "Increase to $30.00?" }),
    ).toBeNull();
  });

  it("keeps an increase failure visible on the notification", async () => {
    notifications.value = [makeCostNotification()];
    notifications.workflowRun = makeRunState();
    actions.increaseCostLimit.mockImplementationOnce(
      (_input: unknown, options: { onError: (error: Error) => void }) =>
        options.onError(new Error("cost limit changed since it was read")),
    );
    renderStack();

    fireEvent.click(await screen.findByRole("button", { name: "Yes" }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("cost limit changed since it was read");
    expect(alert.className).toContain("text-destructive");
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
  });

  it("reports the new limit and stops asking after a successful increase", async () => {
    notifications.value = [makeCostNotification()];
    notifications.workflowRun = makeRunState();
    actions.increaseCostLimit.mockImplementationOnce(
      (
        _input: unknown,
        options: { onSuccess: (result: { current_limit_usd: number }) => void },
      ) => options.onSuccess({ current_limit_usd: 30 }),
    );
    renderStack();

    fireEvent.click(await screen.findByRole("button", { name: "Yes" }));

    expect(screen.getByText("Cost limit increased to $30.00.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Increase to $30.00?" }),
    ).toBeNull();
  });

  it("collapses the cards to the unread total when minimized", async () => {
    notifications.value = [1, 2, 3, 4, 5, 6, 7].map((id) =>
      makeNotification(id),
    );
    renderStack();

    fireEvent.click(
      await screen.findByRole("button", { name: "Minimize notifications" }),
    );

    expect(screen.queryByText("Notification 7")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "7 unread", expanded: false }),
    ).toBeTruthy();
    expect(actions.read).not.toHaveBeenCalled();
    expect(actions.readAll).not.toHaveBeenCalled();
  });

  it("shows the unread notifications again when expanded", async () => {
    notifications.value = [1, 2, 3, 4, 5, 6, 7].map((id) =>
      makeNotification(id),
    );
    renderStack();

    fireEvent.click(
      await screen.findByRole("button", { name: "Minimize notifications" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "7 unread" }));

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      [
        expect.stringContaining("Notification 7"),
        expect.stringContaining("Notification 6"),
        expect.stringContaining("Notification 5"),
        expect.stringContaining("Notification 4"),
        expect.stringContaining("Notification 3"),
      ],
    );
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Minimize notifications",
        expanded: true,
      }),
    ).toBeTruthy();
  });

  it("keeps keyboard focus on the control that folds and unfolds the stack", async () => {
    notifications.value = [makeNotification(1), makeNotification(2)];
    renderStack();

    const minimizeButton = await screen.findByRole("button", {
      name: "Minimize notifications",
    });
    minimizeButton.focus();
    fireEvent.click(minimizeButton);

    const expandButton = screen.getByRole("button", { name: "2 unread" });
    expect(document.activeElement).toBe(expandButton);
    fireEvent.click(expandButton);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Minimize notifications" }),
    );
  });

  it("counts unread notifications arriving while minimized", async () => {
    notifications.value = [makeNotification(1)];
    renderStack();

    fireEvent.click(
      await screen.findByRole("button", { name: "Minimize notifications" }),
    );
    deliverNotifications([makeNotification(1), makeNotification(2)]);

    expect(screen.getByRole("button", { name: "2 unread" })).toBeTruthy();
    expect(screen.queryByText("Notification 2")).toBeNull();
  });

  it("stays minimized when the page is loaded again", async () => {
    notifications.value = [makeNotification(1)];
    renderStack();

    fireEvent.click(
      await screen.findByRole("button", { name: "Minimize notifications" }),
    );
    cleanup();
    renderStack();

    expect(
      await screen.findByRole("button", { name: "1 unread" }),
    ).toBeTruthy();
    expect(screen.queryByText("Notification 1")).toBeNull();
  });

  it("shows nothing while minimized once no notification is unread", async () => {
    notifications.value = [makeNotification(1)];
    renderStack();

    fireEvent.click(
      await screen.findByRole("button", { name: "Minimize notifications" }),
    );
    deliverNotifications([
      makeNotification(1, { read_at: "2026-01-01T00:01:00Z" }),
    ]);

    expect(
      screen.queryByRole("region", { name: "Unread notifications" }),
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
