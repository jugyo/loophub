import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import { WebConfigProvider } from "@/lib/web-config";
import { repoRoute } from "./repo";
import { repoScheduledTasksRoute } from "./repo-scheduled-tasks";
import { rootRoute } from "./root";

vi.mock("@/components/app-layout", async () => {
  const { Outlet } = await import("@tanstack/react-router");
  return { AppLayout: () => <Outlet /> };
});
vi.mock("@/lib/use-loophub-events", () => ({ useLoopHubEvents: () => {} }));
vi.mock("@/components/issue-list", () => ({ IssueList: () => null }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal: vi.fn() }),
}));

function renderRoute(experimental: boolean) {
  vi.stubGlobal("fetch", mockRpcFetch({ "scheduledTasks/list": () => [] }));
  const router = createRouter({
    routeTree: rootRoute.addChildren([repoRoute, repoScheduledTasksRoute]),
    history: createMemoryHistory({
      initialEntries: ["/r/me/proj/scheduled-tasks"],
    }),
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

describe("repo scheduled tasks route", () => {
  it("redirects to the repository when experimental UI is disabled", async () => {
    const router = renderRoute(false);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/me/proj"),
    );
    expect(screen.queryByText("No scheduled tasks yet.")).toBeNull();
  });

  it("shows the existing screen when experimental UI is enabled", async () => {
    renderRoute(true);
    expect(await screen.findByText("No scheduled tasks yet.")).toBeTruthy();
  });
});
