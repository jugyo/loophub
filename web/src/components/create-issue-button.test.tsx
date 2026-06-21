import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { CreateIssueButton } from "./create-issue-button";

afterEach(() => {
  cleanup();
});

function renderButton() {
  return render(<CreateIssueButton />);
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
  return screen.getByRole("dialog");
}

describe("CreateIssueButton", () => {
  it("opens a dialog with an intent field but no command until typed", () => {
    renderButton();
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = openDialog();
    expect(dialog).toBeTruthy();

    // The intent field where the human describes what they want.
    expect(screen.getByLabelText("What do you want to do?")).toBeTruthy();
    // The command stays hidden while the field is empty.
    expect(screen.queryByText(/\/loophub-issue-create/)).toBeNull();
    // No legacy create-issue form remains.
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.queryByLabelText("Body")).toBeNull();
    expect(screen.queryByRole("button", { name: /create issue/i })).toBeNull();
  });

  it("reveals the command only once intent is entered", () => {
    renderButton();
    openDialog();
    const field = screen.getByLabelText("What do you want to do?");
    expect(screen.queryByText(/\/loophub-issue-create/)).toBeNull();
    fireEvent.change(field, { target: { value: "fix the login bug" } });
    expect(screen.getByText(/\/loophub-issue-create/)).toBeTruthy();
    // Whitespace-only input does not count as intent.
    fireEvent.change(field, { target: { value: "   " } });
    expect(screen.queryByText(/\/loophub-issue-create/)).toBeNull();
  });

  it("renders a roomy, uncapped intent field", () => {
    renderButton();
    openDialog();
    const field = screen.getByLabelText(
      "What do you want to do?",
    ) as HTMLTextAreaElement;
    expect(field.tagName).toBe("TEXTAREA");
    // No hard character limit — 400 is only a sizing hint.
    expect(field.maxLength).toBe(-1);
    expect(Number(field.rows)).toBeGreaterThanOrEqual(4);
  });

  it("builds the Claude command from the typed intent", () => {
    renderButton();
    openDialog();
    const field = screen.getByLabelText("What do you want to do?");
    fireEvent.change(field, { target: { value: "add a dark mode toggle" } });
    expect(
      screen.getByText(
        'claude "/loophub-issue-create add a dark mode toggle"',
      ),
    ).toBeTruthy();
  });

  it("escapes shell metacharacters in the generated command", () => {
    renderButton();
    openDialog();
    const field = screen.getByLabelText("What do you want to do?");
    fireEvent.change(field, {
      target: { value: 'add a "dark mode" toggle with `$(whoami)`' },
    });
    // Quotes, backticks and $ are backslash-escaped so the pasted command
    // keeps the intent as a single, inert double-quoted argument.
    expect(
      screen.getByText(
        'claude "/loophub-issue-create add a \\"dark mode\\" toggle with \\`\\$(whoami)\\`"',
      ),
    ).toBeTruthy();
  });

  it("does not show a CLI hint", () => {
    renderButton();
    openDialog();
    expect(screen.queryByText(/lh issue create/)).toBeNull();
  });

  it("closes on Escape", () => {
    renderButton();
    openDialog();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on the close button", () => {
    renderButton();
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
