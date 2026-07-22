import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "@/api/types";
import { NotificationStack } from "./notification-stack";

const notifications = vi.hoisted(() => ({
  value: [] as Notification[],
  isError: false,
}));
const actions = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  showError: vi.fn(),
}));

vi.mock("@/queries/notifications", () => ({
  useNotifications: (input: unknown) => {
    actions.list(input);
    return { data: notifications.value, isError: notifications.isError };
  },
  useReadNotification: () => ({ mutate: actions.read }),
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError: actions.showError }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  notifications.value = [];
  notifications.isError = false;
});

function makeNotification(
  id: number,
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id,
    kind: "merge_ready",
    repo: { name: "me/proj" },
    title: `Notification ${id}`,
    body: `Body ${id}`,
    resource: { kind: "pull", number: id, href: `/pulls/${id}` },
    herdr_pane_id: null,
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("NotificationStack", () => {
  it("keeps notification loading errors visible", () => {
    notifications.isError = true;

    render(<NotificationStack />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Failed to load notifications.",
    );
  });

  it("stacks every unread notification at the bottom right", () => {
    notifications.value = [
      makeNotification(1),
      makeNotification(2),
      makeNotification(3, { read_at: "2026-01-01T00:01:00Z" }),
    ];

    render(<NotificationStack />);

    const stack = screen.getByRole("region", {
      name: "Unread notifications",
    });
    expect(stack.className).toContain("fixed");
    expect(stack.className).toContain("right-4");
    expect(stack.className).toContain("bottom-12");
    expect(actions.list).toHaveBeenCalledWith({ unreadOnly: true });
    expect(screen.getByText("Notification 1")).toBeTruthy();
    expect(screen.getByText("Notification 2")).toBeTruthy();
    expect(screen.queryByText("Notification 3")).toBeNull();
  });

  it("marks each closed notification read independently", () => {
    notifications.value = [makeNotification(1), makeNotification(2)];
    render(<NotificationStack />);

    fireEvent.click(
      screen.getByRole("button", { name: "Close Notification 1" }),
    );

    expect(actions.read).toHaveBeenCalledTimes(1);
    expect(actions.read).toHaveBeenCalledWith(1, expect.any(Object));

    fireEvent.click(
      screen.getByRole("button", { name: "Close Notification 2" }),
    );

    expect(actions.read).toHaveBeenCalledTimes(2);
    expect(actions.read).toHaveBeenLastCalledWith(2, expect.any(Object));
  });
});
