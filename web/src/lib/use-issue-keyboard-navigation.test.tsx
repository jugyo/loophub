import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useIssueKeyboardNavigation } from "./use-issue-keyboard-navigation";

afterEach(cleanup);

function TestIssueRows({ showMenu = false }: { showMenu?: boolean }) {
  const mainRef = useRef<HTMLElement>(null);
  const [opened, setOpened] = useState("");
  useIssueKeyboardNavigation(mainRef);
  return (
    <main ref={mainRef}>
      <input aria-label="filter" />
      {showMenu ? (
        <>
          <div role="menu">
            <button type="button" role="menuitem">
              Close
            </button>
          </div>
          <button type="button" aria-expanded="true">
            More actions
          </button>
        </>
      ) : null}
      <div data-issue-row tabIndex={-1}>
        <a
          href="/issues/1"
          data-issue-row-link
          onClick={(event) => {
            event.preventDefault();
            setOpened("one");
          }}
        >
          One
        </a>
      </div>
      <div data-issue-row tabIndex={-1}>
        <a
          href="/issues/2"
          data-issue-row-link
          onClick={(event) => {
            event.preventDefault();
            setOpened("two");
          }}
        >
          Two
        </a>
      </div>
      <output>{opened}</output>
    </main>
  );
}

describe("useIssueKeyboardNavigation", () => {
  it("moves issue-row focus with vim keys and opens the focused row with Enter", () => {
    const { container } = render(<TestIssueRows />);
    const rows = container.querySelectorAll<HTMLElement>("[data-issue-row]");

    fireEvent.keyDown(window, { key: "j" });
    expect(document.activeElement).toBe(rows[0]);

    fireEvent.keyDown(rows[0], { key: "j" });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1], { key: "k" });
    expect(document.activeElement).toBe(rows[0]);

    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(screen.getByText("two")).toBeTruthy();
  });

  it("ignores shortcuts while an editable field has focus", () => {
    const { container } = render(<TestIssueRows />);
    const input = screen.getByLabelText("filter");
    input.focus();

    fireEvent.keyDown(input, { key: "j" });

    expect(document.activeElement).toBe(input);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-issue-row]")),
    ).not.toContain(document.activeElement);
  });

  it("ignores shortcuts while a menu owns keyboard focus", () => {
    const { container } = render(<TestIssueRows showMenu />);
    const menuItem = screen.getByRole("menuitem", { name: "Close" });
    menuItem.focus();

    fireEvent.keyDown(menuItem, { key: "ArrowDown" });

    expect(document.activeElement).toBe(menuItem);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-issue-row]")),
    ).not.toContain(document.activeElement);
  });

  it("ignores shortcuts while a menu is open even when focus stays on its trigger", () => {
    const { container } = render(<TestIssueRows showMenu />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(document.activeElement).toBe(trigger);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-issue-row]")),
    ).not.toContain(document.activeElement);
  });
});
