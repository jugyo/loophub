import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// CreateIssueButton opens a modal (CreateIssueModal) that hosts a terminal running the
// /lh-issue-create skill in the repo from useCurrentRepo(). TerminalView is stubbed: it pulls in
// xterm + a WebSocket, neither of which works under jsdom, so we record the props it receives.
const terminalProps = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
vi.mock("@/components/terminal-view", () => ({
  TerminalView: (props: Record<string, unknown>) => {
    terminalProps.value = props;
    return <div data-testid="terminal-view" />;
  },
}));
const currentRepo = vi.hoisted(() => ({ value: "me/proj" as string | null }));
vi.mock("@/lib/use-current-repo", () => ({
  useCurrentRepo: () => currentRepo.value,
}));
const terminalLaunchConfig = vi.hoisted(() => ({
  value: { isSuccess: true, data: { backend: "builtin" } },
}));
vi.mock("@/queries/terminal", () => ({
  useTerminalLaunchConfig: () => terminalLaunchConfig.value,
}));
const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));

import { CreateIssueButton } from "./create-issue-button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  terminalProps.value = null;
  currentRepo.value = "me/proj";
  terminalLaunchConfig.value = {
    isSuccess: true,
    data: { backend: "builtin" },
  };
  launchTerminal.mockClear();
});

describe("CreateIssueButton", () => {
  it("renders a New issue button", () => {
    render(<CreateIssueButton />);
    expect(screen.getByRole("button", { name: /new issue/i })).toBeTruthy();
  });

  it("renders nothing on a non-repo screen (no current repo)", () => {
    currentRepo.value = null;
    const { container } = render(<CreateIssueButton />);
    expect(screen.queryByRole("button", { name: /new issue/i })).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("does not open the modal until the button is clicked", () => {
    render(<CreateIssueButton />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a modal dialog hosting the /lh-issue-create terminal scoped to the current repo", () => {
    render(<CreateIssueButton />);
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("terminal-view")).toBeTruthy();
    expect(terminalProps.value).toMatchObject({
      command: "lh issue new --repo me/proj",
      repo: "me/proj",
      // active must be true so TerminalView fits + focuses; pin it so a regression that drops
      // the prop is caught (a hidden/unfocused terminal in the modal).
      active: true,
    });
  });

  it("closes the modal (tearing down the terminal) via the close button", () => {
    render(<CreateIssueButton />);
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /close new issue/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });

  it("dispatches the issue-create workflow through Herdr instead of opening the builtin modal", () => {
    terminalLaunchConfig.value = {
      isSuccess: true,
      data: { backend: "herdr" },
    };
    render(<CreateIssueButton />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: expect.stringMatching(/^New issue - [a-z0-9]+$/i),
      workflow: "issue-create",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });

  it("gives each consecutive Herdr launch a distinct agent name label", () => {
    terminalLaunchConfig.value = {
      isSuccess: true,
      data: { backend: "herdr" },
    };
    render(<CreateIssueButton />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    const first = launchTerminal.mock.calls[0][0].label;
    launchTerminal.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    const second = launchTerminal.mock.calls[0][0].label;

    expect(first).not.toBe(second);
  });
});
