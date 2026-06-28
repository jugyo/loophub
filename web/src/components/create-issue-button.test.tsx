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
vi.mock("@/lib/use-current-repo", () => ({
  useCurrentRepo: () => "me/proj",
}));

import { CreateIssueButton } from "./create-issue-button";

afterEach(() => {
  cleanup();
  terminalProps.value = null;
});

describe("CreateIssueButton", () => {
  it("renders a New issue button", () => {
    render(<CreateIssueButton />);
    expect(screen.getByRole("button", { name: /new issue/i })).toBeTruthy();
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
      command: 'claude "/lh-issue-create"',
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
});
