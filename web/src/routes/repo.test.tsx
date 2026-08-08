import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import { repoRoute, validateIssueListSearch } from "./repo";
import { rootRoute } from "./root";

vi.mock("@/components/app-layout", async () => {
  const { Outlet } = await import("@tanstack/react-router");
  return { AppLayout: () => <Outlet /> };
});
vi.mock("@/lib/use-loophub-events", () => ({ useLoopHubEvents: () => {} }));
vi.mock("@/components/issue-list", () => ({
  IssueList: () => <div>Issue list</div>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderRoute(path: string) {
  vi.stubGlobal("fetch", mockRpcFetch({}));
  const router = createRouter({
    routeTree: rootRoute.addChildren([repoRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("repository search route placement", () => {
  it("normalizes workspace, state, and label filters without serializing defaults", () => {
    expect(
      validateIssueListSearch({
        workspace: " feature/alpha ",
        labels: " bug ",
        state: "all",
      }),
    ).toEqual({ workspace: "feature/alpha", labels: "bug", state: "all" });
    expect(
      validateIssueListSearch({ workspace: " ", labels: " ", state: "open" }),
    ).toEqual({});
  });

  it("shows the search row and the sidebar on the repository top", async () => {
    renderRoute("/r/me/proj");
    expect(
      await screen.findByRole("button", {
        name: "Search issues",
      }),
    ).toBeTruthy();
    // The sidebar (#71) sits beside the issue list; its origin section loads on its own.
    expect(await screen.findByText("Origin")).toBeTruthy();
    // The standalone workspace picker was removed (#1511); New workspace now
    // lives inside the IssueList workspace filter dropdown.
    expect(screen.queryByRole("button", { name: "Workspaces" })).toBeNull();
  });
});
