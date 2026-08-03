import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBackdropDismiss } from "./use-backdrop-dismiss";

function Dialog({ onDismiss }: { onDismiss: () => void }) {
  const backdropDismiss = useBackdropDismiss(onDismiss);

  return (
    <div data-testid="backdrop" {...backdropDismiss}>
      <div role="dialog">Selectable dialog text</div>
    </div>
  );
}

describe("useBackdropDismiss", () => {
  it("dismisses on a programmatic backdrop click", () => {
    const onDismiss = vi.fn();
    render(<Dialog onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId("backdrop"));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("dismisses when the mouse action starts and ends on the backdrop", () => {
    const onDismiss = vi.fn();
    render(<Dialog onDismiss={onDismiss} />);
    const backdrop = screen.getByTestId("backdrop");

    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not dismiss when a text selection starts in the dialog and ends on the backdrop", () => {
    const onDismiss = vi.fn();
    render(<Dialog onDismiss={onDismiss} />);
    const dialog = screen.getByRole("dialog");
    const backdrop = screen.getByTestId("backdrop");

    fireEvent.mouseDown(dialog);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss when the mouse action ends in the dialog", () => {
    const onDismiss = vi.fn();
    render(<Dialog onDismiss={onDismiss} />);
    const dialog = screen.getByRole("dialog");
    const backdrop = screen.getByTestId("backdrop");

    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(dialog);
    fireEvent.click(backdrop);

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
