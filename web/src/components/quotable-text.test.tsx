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

  describe("button position", () => {
    function rect(left: number, top: number, right: number, bottom: number) {
      return { left, top, right, bottom, width: right - left } as DOMRect;
    }

    // The selection spans y 100..160 of a body at (10, 50) that is 300 wide.
    function renderMeasured() {
      renderBody();
      vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
        rect(30, 100, 200, 160),
      );
      vi.spyOn(
        screen.getByText("Inside").parentElement!,
        "getBoundingClientRect",
      ).mockReturnValue(rect(10, 50, 310, 200));
      return screen.getByText("Inside").firstChild!;
    }

    function selectBackward(text: Node) {
      const selection = document.getSelection()!;
      selection.setBaseAndExtent(text, 6, text, 0);
      act(() => {
        document.dispatchEvent(new Event("selectionchange"));
      });
    }

    function quoteStyle() {
      return screen.getByRole("button", { name: "Quote" }).style;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("waits for the mouse release and follows it below a forward selection", () => {
      const text = renderMeasured();

      fireEvent.mouseDown(document);
      selectRange(text, 0, text, 6);
      expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();

      fireEvent.mouseUp(document, { clientX: 110 });
      expect(quoteStyle().left).toBe("100px");
      expect(quoteStyle().top).toBe("114px");
    });

    it("goes above a selection dragged upward", () => {
      const text = renderMeasured();

      fireEvent.mouseDown(document);
      selectBackward(text);
      fireEvent.mouseUp(document, { clientX: 110 });

      expect(quoteStyle().left).toBe("100px");
      expect(quoteStyle().top).toBe("16px");
    });

    it("stays within the body when released past its edges", () => {
      const text = renderMeasured();

      fireEvent.mouseDown(document);
      selectRange(text, 0, text, 6);
      fireEvent.mouseUp(document, { clientX: 500 });
      expect(quoteStyle().left).toBe("216px");

      fireEvent.mouseDown(document);
      fireEvent.mouseUp(document, { clientX: 0 });
      expect(quoteStyle().left).toBe("0px");
    });

    it("sits above the start of a keyboard selection, even after a mouse one", () => {
      const text = renderMeasured();

      fireEvent.mouseDown(document);
      selectRange(text, 0, text, 2);
      fireEvent.mouseUp(document, { clientX: 110 });

      fireEvent.keyDown(document, { key: "ArrowRight", shiftKey: true });
      selectRange(text, 0, text, 6);

      expect(quoteStyle().left).toBe("20px");
      expect(quoteStyle().top).toBe("16px");
    });

    it("keeps its place when the button itself is pressed", () => {
      const text = renderMeasured();

      fireEvent.mouseDown(document);
      selectRange(text, 0, text, 6);
      fireEvent.mouseUp(document, { clientX: 110 });

      const button = screen.getByRole("button", { name: "Quote" });
      fireEvent.mouseDown(button);
      fireEvent.mouseUp(button, { clientX: 250 });

      expect(quoteStyle().left).toBe("100px");
    });
  });
});
