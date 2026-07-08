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
import { mockRpcFetch } from "@/api/rpc-mock";
import type { ScheduledTask } from "@/api/types";

const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));

import { ScheduledTasksPage } from "./scheduled-tasks-page";

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 1,
    title: "Daily triage",
    prompt: "Review ready issues",
    agent: "codex",
    times: ["09:00"],
    model: null,
    effort: null,
    default_model: "gpt-5.5",
    default_effort: "medium",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderPage(tasks: ScheduledTask[] = []) {
  vi.stubGlobal("fetch", mockRpcFetch({ "scheduledTasks/list": () => tasks }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const scheduledRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/scheduled-tasks",
    component: () => <ScheduledTasksPage owner="me" repo="proj" />,
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([scheduledRoute, repoRoute]),
    history: createMemoryHistory({
      initialEntries: ["/r/me/proj/scheduled-tasks"],
    }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  launchTerminal.mockClear();
});

describe("ScheduledTasksPage", () => {
  it("launches the scheduled-task-create Herdr workflow from New scheduled task", async () => {
    renderPage();

    expect(await screen.findByText("No scheduled tasks yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New scheduled task" }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: expect.stringMatching(/^New scheduled task - [a-z0-9]+$/i),
      workflow: "scheduled-task-create",
    });
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();
  });

  it("keeps existing scheduled tasks visible and editable", async () => {
    renderPage([task()]);

    expect(await screen.findByText("Daily triage")).toBeTruthy();
    expect(screen.getByText("Review ready issues")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("textbox", { name: "Title" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeTruthy();
  });
});
