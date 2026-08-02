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
import { ApiError } from "@/api/client";
import { ToastProvider, ToastViewport } from "@/components/toast";
import {
  TerminalControllerProvider,
  TerminalLaunchErrorDialog,
  useTerminalLauncher,
} from "./terminal-controller";

const launchMutation = vi.hoisted(() => ({
  mutate: vi.fn(
    (
      _input: unknown,
      opts?: {
        onSuccess?: (result: {
          session_name?: string;
          attach?: string;
        }) => void;
        onError?: (e: unknown) => void;
      },
    ) => {
      opts?.onSuccess?.({
        session_name: "jugyo-loophub-deadbeef",
        attach: "herdr attach jugyo-loophub-deadbeef",
      });
    },
  ),
}));

vi.mock("@/queries/terminal", () => ({
  useLaunchTerminalWorkflow: () => launchMutation,
}));

function LaunchButton({
  workflow = "workflow-run",
  agent,
  model,
  effort,
}: {
  workflow?:
    | "workflow-run"
    | "issue-create"
    | "scheduled-task-create"
    | "github-pr-export";
  agent?: "claude-code" | "codex" | "grok";
  model?: string;
  effort?: string;
}) {
  const { launchTerminal } = useTerminalLauncher();
  return (
    <button
      type="button"
      onClick={() =>
        launchTerminal({
          repo: "jugyo/loophub",
          label: "dev #444",
          workflow,
          issueNumber: 444,
          agent,
          model,
          effort,
        })
      }
    >
      Launch
    </button>
  );
}

afterEach(() => {
  cleanup();
  launchMutation.mutate.mockClear();
});

describe("TerminalController", () => {
  it("does not show a toast after a workflow-run launch succeeds (#680)", async () => {
    // ToastProvider clears on route change, so it needs a real router in the tree (matches
    // toast.test.tsx / pull-detail.test.tsx).
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <TerminalControllerProvider>
          <ToastProvider>
            <ToastViewport />
            <LaunchButton />
          </ToastProvider>
        </TerminalControllerProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));

    expect(launchMutation.mutate).toHaveBeenCalledWith(
      {
        repo: "jugyo/loophub",
        label: "dev #444",
        workflow: "workflow-run",
        issueNumber: 444,
        prNumber: undefined,
        agent: undefined,
        model: undefined,
      },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not show a toast after a non-Build launch succeeds", async () => {
    // ToastProvider clears on route change, so it needs a real router in the tree (matches
    // toast.test.tsx / pull-detail.test.tsx).
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <TerminalControllerProvider>
          <ToastProvider>
            <ToastViewport />
            <LaunchButton workflow="issue-create" />
          </ToastProvider>
        </TerminalControllerProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("forwards one-shot New issue agent, model, and effort overrides", async () => {
    const rootRoute = createRootRoute({ component: Outlet });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <TerminalControllerProvider>
          <ToastProvider>
            <LaunchButton
              workflow="issue-create"
              agent="codex"
              model="gpt-5.6-sol"
              effort="high"
            />
          </ToastProvider>
        </TerminalControllerProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));

    expect(launchMutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: "issue-create",
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("shows an overlay dialog with the reason, example command, and session-creation hint when the launch fails (#483)", () => {
    launchMutation.mutate.mockImplementationOnce((_input, opts) => {
      opts?.onError?.(
        new ApiError(500, "Herdr exited with status 1", {
          command: "herdr --session jugyo-loophub-444 agent start 'dev #444'",
          session: "jugyo-loophub-444",
        }),
      );
    });

    render(
      <TerminalControllerProvider>
        <TerminalLaunchErrorDialog />
        <LaunchButton />
      </TerminalControllerProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Herdr exited with status 1")).toBeTruthy();
    expect(
      screen.getByText(
        "herdr --session jugyo-loophub-444 agent start 'dev #444'",
      ),
    ).toBeTruthy();
    expect(screen.getByText("herdr --session jugyo-loophub-444")).toBeTruthy();
  });
});
