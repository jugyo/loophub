import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// CreateIssueButton opens a terminal via useTerminal() in the repo from useCurrentRepo().
const { openTerminal } = vi.hoisted(() => ({ openTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminal: () => ({ openTerminal }),
}));
vi.mock("@/lib/use-current-repo", () => ({
  useCurrentRepo: () => "me/proj",
}));

import { CreateIssueButton } from "./create-issue-button";

afterEach(() => {
  cleanup();
  openTerminal.mockClear();
});

describe("CreateIssueButton", () => {
  it("renders a New issue button", () => {
    render(<CreateIssueButton />);
    expect(screen.getByRole("button", { name: /new issue/i })).toBeTruthy();
  });

  it("launches the /lh-issue-create skill in a terminal scoped to the current repo", () => {
    render(<CreateIssueButton />);
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    expect(openTerminal).toHaveBeenCalledWith({
      command: 'claude "/lh-issue-create"',
      repo: "me/proj",
      label: "New issue",
    });
  });

  it("does not open a modal dialog (the paste-command flow is gone)", () => {
    render(<CreateIssueButton />);
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
