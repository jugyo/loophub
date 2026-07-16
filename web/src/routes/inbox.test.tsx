import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import { WebConfigProvider } from "@/lib/web-config";
import { inboxRoute } from "./inbox";
import { rootRoute } from "./root";

vi.mock("@/components/app-layout", async () => {
  const { Outlet } = await import("@tanstack/react-router");
  return { AppLayout: () => <Outlet /> };
});
vi.mock("@/lib/use-loophub-events", () => ({ useLoopHubEvents: () => {} }));
vi.mock("@/components/dashboard-section", () => ({
  DashboardSection: () => <div>Dashboard</div>,
}));

function renderRoute(experimental: boolean) {
  vi.stubGlobal("fetch", mockRpcFetch({ "inbox/list": () => [] }));
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>Dashboard</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, inboxRoute]),
    history: createMemoryHistory({ initialEntries: ["/inbox"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WebConfigProvider config={{ experimental }}>
        <RouterProvider router={router} />
      </WebConfigProvider>
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("inbox route", () => {
  it("redirects to the dashboard when experimental UI is disabled", async () => {
    const router = renderRoute(false);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("heading", { name: "Inbox" })).toBeNull();
  });

  it("shows the existing screen when experimental UI is enabled", async () => {
    renderRoute(true);
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeTruthy();
  });
});
