import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { CreateIssueButton } from "./create-issue-button";

afterEach(() => {
  cleanup();
});

function renderButton() {
  return render(<CreateIssueButton />);
}

describe("CreateIssueButton", () => {
  it("opens a guidance dialog on click, not a form", () => {
    renderButton();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    // The skill is the documented way to file an issue.
    expect(screen.getByText("/loophub-issue-create")).toBeTruthy();
    // No input form / submit action remains in this flow.
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.queryByLabelText("Body")).toBeNull();
    expect(screen.queryByRole("button", { name: /create issue/i })).toBeNull();
  });

  it("does not show a CLI hint", () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    expect(screen.queryByText(/lh issue create/)).toBeNull();
  });

  it("closes on Escape", () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on the close button", () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
