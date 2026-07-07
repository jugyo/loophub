import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));

import { CreateIssueButton } from "./create-issue-button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  launchTerminal.mockClear();
});

describe("CreateIssueButton", () => {
  it("renders a New issue button", () => {
    render(<CreateIssueButton repo="me/proj" />);
    expect(screen.getByRole("button", { name: /new issue/i })).toBeTruthy();
  });

  it("dispatches the issue-create workflow through Herdr", () => {
    render(<CreateIssueButton repo="me/proj" />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: expect.stringMatching(/^New issue - [a-z0-9]+$/i),
      workflow: "issue-create",
    });
  });

  it("renders as a regular button instead of a fixed floating action button", () => {
    render(<CreateIssueButton repo="me/proj" />);
    const button = screen.getByRole("button", { name: /new issue/i });
    expect(button.textContent).toContain("New issue");
    expect(button.className).not.toContain("fixed");
    expect(button.className).not.toContain("rounded-full");
  });

  it("gives each consecutive launch a distinct agent name label", () => {
    render(<CreateIssueButton repo="me/proj" />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    const first = launchTerminal.mock.calls[0][0].label;
    launchTerminal.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    const second = launchTerminal.mock.calls[0][0].label;

    expect(first).not.toBe(second);
  });
});
