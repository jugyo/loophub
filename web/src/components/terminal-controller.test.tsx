import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import {
  TerminalControllerProvider,
  TerminalLaunchErrorDialog,
  TerminalLaunchFeedback,
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

function LaunchButton() {
  const { launchTerminal } = useTerminalLauncher();
  return (
    <button
      type="button"
      onClick={() =>
        launchTerminal({
          repo: "jugyo/loophub",
          label: "dev #444",
          workflow: "issue-dev",
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
  it("shows the Herdr session name and attach command after a launch succeeds", () => {
    render(
      <TerminalControllerProvider>
        <TerminalLaunchFeedback />
        <LaunchButton />
      </TerminalControllerProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(launchMutation.mutate).toHaveBeenCalledWith(
      {
        repo: "jugyo/loophub",
        label: "dev #444",
        workflow: "issue-dev",
        issueNumber: 444,
        prNumber: undefined,
        session: undefined,
        cwd: undefined,
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(
      screen.getByText(
        "Launched in jugyo-loophub-deadbeef. Attach: herdr attach jugyo-loophub-deadbeef",
      ),
    ).toBeTruthy();
  });

  it("shows a 'switched to existing terminal' message instead of the launch message when the backend focused an existing pane (#578)", () => {
    launchMutation.mutate.mockImplementationOnce((_input, opts) => {
      opts?.onSuccess?.({
        session_name: "jugyo-loophub-deadbeef",
        focused: true,
      });
    });

    render(
      <TerminalControllerProvider>
        <TerminalLaunchFeedback />
        <LaunchButton />
      </TerminalControllerProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(screen.getByText("Switched to the existing terminal.")).toBeTruthy();
    expect(screen.queryByText(/^Launched in/)).toBeNull();
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
