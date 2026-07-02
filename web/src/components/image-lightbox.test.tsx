import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "./image-lightbox";

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
    // Simulates being nested inside another modal (e.g. MarkdownPreviewModal) that also
    // listens for Escape on `document` — the lightbox must stop the event from reaching it.
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
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.style.transform).toBe("scale(1)");

    fireEvent.wheel(screen.getByRole("dialog"), { deltaY: -100 });
    const scaledUp = Number(
      img.style.transform.match(/scale\(([\d.]+)\)/)?.[1],
    );
    expect(scaledUp).toBeGreaterThan(1);

    fireEvent.wheel(screen.getByRole("dialog"), { deltaY: 1000 });
    const scaledDown = Number(
      img.style.transform.match(/scale\(([\d.]+)\)/)?.[1],
    );
    expect(scaledDown).toBeLessThan(scaledUp);
    expect(scaledDown).toBeGreaterThanOrEqual(1);
  });
});
