import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerminalControllerProvider,
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
        }) => void;
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
  useTerminalLaunchConfig: () => ({
    isSuccess: true,
    data: { backend: "herdr" },
  }),
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
});
