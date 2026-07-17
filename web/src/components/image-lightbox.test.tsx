import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "./image-lightbox";

function contentTransform() {
  const img = screen.getByRole("img");
  return (img.parentElement as HTMLElement).style.transform;
}

function setPanGeometry({
  dialog,
  content,
  width,
  height,
  viewportWidth,
  viewportHeight,
}: {
  dialog: HTMLElement;
  content: HTMLElement;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}) {
  Object.defineProperty(dialog, "clientWidth", {
    configurable: true,
    value: viewportWidth,
  });
  Object.defineProperty(dialog, "clientHeight", {
    configurable: true,
    value: viewportHeight,
  });
  Object.defineProperty(content, "offsetWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(content, "offsetHeight", {
    configurable: true,
    value: height,
  });
  content.getBoundingClientRect = () =>
    ({
      width,
      height,
    }) as DOMRect;
}

describe("ImageLightbox", () => {
  it("does not close when the image itself is clicked", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        src="https://example.com/pic.png"
        alt="a pic"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("img"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes via the close button", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        src="https://example.com/pic.png"
        alt="a pic"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and does not leak the keydown to a document-level listener", () => {
    // Simulates being nested inside another modal that also listens for Escape on
    // `document` — the lightbox must stop the event from reaching it.
    const onClose = vi.fn();
    const outerListener = vi.fn();
    document.addEventListener("keydown", outerListener);
    try {
      render(
        <ImageLightbox
          src="https://example.com/pic.png"
          alt="a pic"
          onClose={onClose}
        />,
      );
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(outerListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outerListener);
    }
  });

  it("traps Tab focus on the close button so Escape keeps working", () => {
    render(
      <ImageLightbox
        src="https://example.com/pic.png"
        alt="a pic"
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const closeButton = screen.getByRole("button", { name: "Close preview" });
    // Initial focus is on the dialog itself (see the mount effect); Tab from there should
    // land on — and stay trapped on — the close button, the only focusable descendant.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(closeButton);
  });

  it("scales the image up on scroll-up and down on scroll-down", () => {
    render(
      <ImageLightbox
        src="https://example.com/pic.png"
        alt="a pic"
        onClose={vi.fn()}
      />,
    );
    expect(contentTransform()).toBe("translate3d(0px, 0px, 0) scale(1)");

    fireEvent.wheel(screen.getByRole("dialog"), { deltaY: -100 });
    const scaledUp = Number(contentTransform().match(/scale\(([\d.]+)\)/)?.[1]);
    expect(scaledUp).toBeGreaterThan(1);

    fireEvent.wheel(screen.getByRole("dialog"), { deltaY: 1000 });
    const scaledDown = Number(
      contentTransform().match(/scale\(([\d.]+)\)/)?.[1],
    );
    expect(scaledDown).toBeLessThan(scaledUp);
    expect(scaledDown).toBeGreaterThanOrEqual(1);
  });

  it("pans the image with mouse drag only after zooming in", () => {
    render(
      <ImageLightbox
        src="https://example.com/pic.png"
        alt="a pic"
        onClose={vi.fn()}
      />,
    );

    const img = screen.getByRole("img");
    fireEvent.mouseDown(img, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 50, clientY: 40 });
    fireEvent.mouseUp(document);
    expect(contentTransform()).toBe("translate3d(0px, 0px, 0) scale(1)");

    fireEvent.wheel(screen.getByRole("dialog"), { deltaY: -100 });
    fireEvent.mouseDown(img, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 50, clientY: 40 });
    fireEvent.mouseUp(document);
    expect(contentTransform()).toMatch(/^translate3d\(40px, 30px, 0\) /);
  });

  it("resets pan when zooming back to the default scale", () => {
    render(
      <ImageLightbox
        src="https://example.com/pic.png"
        alt="a pic"
        onClose={vi.fn()}
      />,
    );

    const img = screen.getByRole("img");
    fireEvent.wheel(screen.getByRole("dialog"), { deltaY: -100 });
    fireEvent.mouseDown(img, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 50, clientY: 40 });
    fireEvent.mouseUp(document);
    expect(contentTransform()).toMatch(/^translate3d\(40px, 30px, 0\) /);

    fireEvent.wheel(screen.getByRole("dialog"), { deltaY: 1000 });
    expect(contentTransform()).toBe("translate3d(0px, 0px, 0) scale(1)");
  });

  it("does not allow pan when zoomed content still fits in the dialog", () => {
    render(
      <ImageLightbox
        src="https://example.com/pic.png"
        alt="a pic"
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const img = screen.getByRole("img");
    setPanGeometry({
      dialog,
      content: img.parentElement as HTMLElement,
      width: 400,
      height: 300,
      viewportWidth: 1000,
      viewportHeight: 800,
    });

    fireEvent.wheel(dialog, { deltaY: -100 });
    fireEvent.mouseDown(img, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 180 });
    fireEvent.mouseUp(document);
    expect(contentTransform()).toMatch(/^translate3d\(0px, 0px, 0\) /);
  });

  it("does not close on the backdrop click that follows a zoomed drag", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        src="https://example.com/pic.png"
        alt="a pic"
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const img = screen.getByRole("img");
    fireEvent.wheel(dialog, { deltaY: -100 });
    fireEvent.mouseDown(img, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 50, clientY: 40 });
    fireEvent.mouseUp(document);

    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
