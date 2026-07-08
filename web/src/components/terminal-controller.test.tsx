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
          focused?: boolean;
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
  workflow = "issue-dev",
}: {
  workflow?:
    | "issue-dev"
    | "issue-create"
    | "scheduled-task-create"
    | "resume"
    | "github-pr-export";
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
  it("does not show a toast after a Build launch succeeds (#680)", async () => {
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
        workflow: "issue-dev",
        issueNumber: 444,
        prNumber: undefined,
        session: undefined,
        cwd: undefined,
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

  it("does not show a toast when the backend focused an existing pane (#578)", async () => {
    launchMutation.mutate.mockImplementationOnce((_input, opts) => {
      opts?.onSuccess?.({
        session_name: "jugyo-loophub-deadbeef",
        focused: true,
      });
    });

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
            <LaunchButton workflow="resume" />
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
