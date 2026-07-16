import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault } from "@/api/rpc-mock";
import { WorkspacePage } from "./workspace-page";

vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal: vi.fn() }),
}));
vi.mock("@/components/dashboard-rows", () => ({
  IssueRow: ({ issue }: { issue: { title: string } }) => (
    <div>{issue.title}</div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage(name: string, handlers: Record<string, () => unknown>) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "repos/get": () => repo,
      "workspaces/list": () => [],
      "labels/list": () => [],
      ...handlers,
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/w/$workspaceName",
    component: () => {
      const { workspaceName } = pageRoute.useParams();
      return <WorkspacePage workspaceName={workspaceName} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({
      initialEntries: [`/r/w/${encodeURIComponent(name)}`],
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const repo = {
  id: 1,
  owner: "me",
  name: "proj",
  full_name: "me/proj",
  default_branch: "main",
  local_path: "/tmp/proj",
  archived: false,
  favorite: false,
  created_at: "2026-01-01T00:00:00Z",
};

describe("WorkspacePage", () => {
  it("shows the resolved workspace on its dedicated page", async () => {
    renderPage("feature/alpha", {
      "workspaces/resolve": () => ({
        repo: { ...repo, owner: { login: "me" } },
        workspace: {
          branch: "feature/alpha",
          created_at: "2026-01-01T00:00:00Z",
          archived_at: null,
          branch_exists: true,
        },
      }),
      "issues/list": () => [],
    });

    expect(
      await screen.findByRole("button", { name: "feature/alpha" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
    expect(screen.getByText("No open issues.")).toBeTruthy();
  });

  it("shows an understandable empty state for an unknown workspace", async () => {
    renderPage("missing", {
      "workspaces/resolve": () => {
        throw new RpcFault(404, "workspace not found: missing");
      },
    });

    expect(
      await screen.findByRole("heading", { name: "Workspace not found" }),
    ).toBeTruthy();
    expect(screen.getByText(/No active workspace named/)).toBeTruthy();
  });

  it("loads later issue pages for the workspace", async () => {
    renderPage("feature/alpha", {
      "workspaces/resolve": () => ({
        repo: { ...repo, owner: { login: "me" } },
        workspace: {
          branch: "feature/alpha",
          created_at: "2026-01-01T00:00:00Z",
          archived_at: null,
          branch_exists: true,
        },
      }),
      "issues/list": (params: { page: number }) =>
        params.page === 1
          ? Array.from({ length: 101 }, (_, index) => {
              const boundaryIssue = index === 100;
              return {
                number: index + 1,
                state: "open",
                title: boundaryIssue
                  ? "Boundary workspace issue"
                  : `Other issue ${index + 1}`,
                body: "",
                target_branch: boundaryIssue ? "feature/alpha" : "other",
                user: { login: "me" },
                labels: [],
                comments: 0,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
                linked_pull_request: null,
                linked_pull_requests: [],
              };
            })
          : [
              {
                number: 101,
                state: "open",
                title: "Boundary workspace issue",
                body: "",
                target_branch: "feature/alpha",
                user: { login: "me" },
                labels: [],
                comments: 0,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
                linked_pull_request: null,
                linked_pull_requests: [],
              },
              {
                number: 102,
                state: "open",
                title: "Later workspace issue",
                body: "",
                target_branch: "feature/alpha",
                user: { login: "me" },
                labels: [],
                comments: 0,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
                linked_pull_request: null,
                linked_pull_requests: [],
              },
            ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Boundary workspace issue")).toBeTruthy();
    expect(await screen.findByText("Later workspace issue")).toBeTruthy();
  });
});
