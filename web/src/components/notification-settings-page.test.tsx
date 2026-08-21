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
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import { NotificationSettingsPage } from "./notification-settings-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSettings(initialNotificationSound = true) {
  let notificationSound = initialNotificationSound;
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "settings/get": () => ({
        agents: {},
        codingAgent: "claude-code",
        devCostLimitUsd: 10,
        notificationSound,
        workflowContractLanguage: "en",
      }),
      "settings/update": (params) => {
        if (params.notificationSound !== undefined) {
          notificationSound = params.notificationSound as boolean;
        }
        return {
          agents: {},
          codingAgent: "claude-code",
          devCostLimitUsd: 10,
          notificationSound,
          workflowContractLanguage: "en",
        };
      },
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const agentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div data-testid="agent-settings" />,
  });
  const notificationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/notifications",
    component: () => <NotificationSettingsPage />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([agentRoute, notificationsRoute]),
    history: createMemoryHistory({
      initialEntries: ["/settings/notifications"],
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("NotificationSettingsPage", () => {
  it("shows the notification sound under its own settings section", async () => {
    renderSettings();

    const nav = await screen.findByRole("navigation", { name: "Settings" });
    const notifications = await screen.findByRole("link", {
      name: "Notifications",
    });
    expect(notifications.getAttribute("aria-current")).toBe("page");
    expect(nav.textContent).toContain("Agent");
    expect(
      (await screen.findByRole("heading", { level: 2, name: "Notifications" }))
        .textContent,
    ).toBe("Notifications");
    expect(
      await screen.findByRole("heading", { name: "Notification sound" }),
    ).toBeTruthy();
  });

  it("turns the notification sound off", async () => {
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: "Play a sound" });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(rpcCall("settings/update")?.params).toMatchObject({
        notificationSound: false,
      }),
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("shows the notification sound as off when it was turned off earlier", async () => {
    renderSettings(false);
    const toggle = await screen.findByRole("switch", { name: "Play a sound" });

    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
  });
});
