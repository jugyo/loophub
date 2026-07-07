import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useIssueKeyboardNavigation } from "./use-issue-keyboard-navigation";

afterEach(cleanup);

function TestIssueRows({
  showMenu = false,
  showRows = true,
  // Bumping this remounts the second row (React key change), replacing its DOM
  // node while keeping the same data-issue-key — mimics a list remount / filter
  // swap that keeps the selected issue.
  rowGen = 0,
}: {
  showMenu?: boolean;
  showRows?: boolean;
  rowGen?: number;
}) {
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
      {showRows ? (
        <>
          <div data-issue-row data-issue-key="o/r#1" tabIndex={-1}>
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
          <div
            key={`row2-${rowGen}`}
            data-issue-row
            data-issue-key="o/r#2"
            tabIndex={-1}
          >
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
        </>
      ) : null}
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

  it("restores the previously selected row when the list re-appears", async () => {
    const { rerender } = render(<TestIssueRows />);

    // Select the second row, then leave the list (rows unmount). Flush so the
    // MutationObserver observes the removal before the list re-appears, matching
    // real navigation where the two happen on separate ticks.
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(document.activeElement ?? window, { key: "j" });
    rerender(<TestIssueRows showRows={false} />);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-issue-row]")).toHaveLength(0),
    );

    // Return to the list: the second row is selected again.
    rerender(<TestIssueRows showRows={true} />);
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute("data-issue-key")).toBe("o/r#2");
    });
  });

  it("re-restores focus when the selected row's node is replaced in place", async () => {
    const { rerender } = render(<TestIssueRows />);

    // Select the second row, leave the list, and return so the restore latch is
    // engaged (restored=true for the old boolean latch).
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(document.activeElement ?? window, { key: "j" });
    rerender(<TestIssueRows showRows={false} />);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-issue-row]")).toHaveLength(0),
    );
    rerender(<TestIssueRows showRows={true} />);
    const restoredNode = await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute("data-issue-key")).toBe("o/r#2");
      return active;
    });

    // A single-commit remount replaces the focused row's node (same key). Focus
    // must land on the fresh node, not be dropped to <body>.
    rerender(<TestIssueRows showRows={true} rowGen={1} />);
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute("data-issue-key")).toBe("o/r#2");
      expect(active).not.toBe(restoredNode);
    });
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
