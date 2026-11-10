import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "#loophub-test";
import { appendQuote, QuotableText } from "./quotable-text";

function select(node: Node | null) {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  if (node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.addRange(range);
  }
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function selectRange(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function renderBody(onQuote: (text: string) => void = () => {}) {
  render(
    <div>
      <p>Outside</p>
      <QuotableText onQuote={onQuote}>
        <p>Inside</p>
      </QuotableText>
      <p>After</p>
    </div>,
  );
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
});

describe("appendQuote", () => {
  it("prefixes every selected line", () => {
    expect(appendQuote("", "first\nsecond")).toBe("> first\n> second\n\n");
  });

  it("adds the quote as a separate paragraph after existing text", () => {
    expect(appendQuote("Draft\n", "selected")).toBe("Draft\n\n> selected\n\n");
  });
});

describe("QuotableText", () => {
  it("offers Quote while text inside is selected and hands it over", () => {
    const onQuote = vi.fn();
    renderBody(onQuote);

    select(screen.getByText("Inside"));
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));

    expect(onQuote).toHaveBeenCalledWith("Inside");
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
  });

  it("offers Quote for a triple-click whose range ends at the next block", () => {
    const onQuote = vi.fn();
    renderBody(onQuote);

    const inside = screen.getByText("Inside");
    selectRange(inside.firstChild!, 0, screen.getByText("After"), 0);
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));

    expect(onQuote).toHaveBeenCalledWith("Inside");
  });

  it("hides Quote when the selection takes in text outside the body", () => {
    renderBody();

    const inside = screen.getByText("Inside").firstChild!;
    const after = screen.getByText("After").firstChild!;
    selectRange(inside, 0, after, 2);
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();

    selectRange(screen.getByText("Outside").firstChild!, 0, inside, 2);
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
  });

  it("hides Quote when the selection is cleared or moves outside", () => {
    renderBody();

    select(screen.getByText("Inside"));
    expect(screen.getByRole("button", { name: "Quote" })).toBeTruthy();
    select(null);
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();

    select(screen.getByText("Inside"));
    select(screen.getByText("Outside"));
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
  });
});
