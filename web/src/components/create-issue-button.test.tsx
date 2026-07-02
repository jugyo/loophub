import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const currentRepo = vi.hoisted(() => ({ value: "me/proj" as string | null }));
vi.mock("@/lib/use-current-repo", () => ({
  useCurrentRepo: () => currentRepo.value,
}));
const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));

import { CreateIssueButton } from "./create-issue-button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  currentRepo.value = "me/proj";
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

  it("dispatches the issue-create workflow through Herdr", () => {
    render(<CreateIssueButton />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: expect.stringMatching(/^New issue - [a-z0-9]+$/i),
      workflow: "issue-create",
    });
  });

  it("uses a fixed 1rem FAB margin", () => {
    render(<CreateIssueButton />);
    const button = screen.getByRole("button", { name: /new issue/i });
    expect(button.style.bottom).toBe("1rem");
  });

  it("gives each consecutive launch a distinct agent name label", () => {
    render(<CreateIssueButton />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    const first = launchTerminal.mock.calls[0][0].label;
    launchTerminal.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    const second = launchTerminal.mock.calls[0][0].label;

    expect(first).not.toBe(second);
  });
});
