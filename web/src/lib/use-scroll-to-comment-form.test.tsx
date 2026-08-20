import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScrollToCommentForm } from "./use-scroll-to-comment-form";

afterEach(() => {
  cleanup();
  scrollIntoView.mockClear();
});

const scrollIntoView = vi.fn();

function Harness() {
  const [count, setCount] = useState(0);
  const { formRef, scrollAfterPost } = useScrollToCommentForm(count);
  return (
    <>
      <div ref={formRef} data-testid="form" />
      <button type="button" onClick={() => scrollAfterPost()}>
        request
      </button>
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        render comment
      </button>
    </>
  );
}

describe("useScrollToCommentForm", () => {
  it("scrolls smoothly once the posted comment has rendered", () => {
    render(<Harness />);
    screen.getByTestId("form").scrollIntoView = scrollIntoView;

    fireEvent.click(screen.getByRole("button", { name: "request" }));
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "render comment" }));
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "nearest",
    });
  });

  it("does not scroll on a comment count change nobody asked for", () => {
    render(<Harness />);
    screen.getByTestId("form").scrollIntoView = scrollIntoView;

    fireEvent.click(screen.getByRole("button", { name: "render comment" }));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls only once per request", () => {
    render(<Harness />);
    screen.getByTestId("form").scrollIntoView = scrollIntoView;

    fireEvent.click(screen.getByRole("button", { name: "request" }));
    fireEvent.click(screen.getByRole("button", { name: "render comment" }));
    fireEvent.click(screen.getByRole("button", { name: "render comment" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
