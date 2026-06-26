import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./copy-button";

afterEach(() => vi.unstubAllGlobals());

describe("CopyButton", () => {
  it("writes the value to the clipboard and shows copied feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<CopyButton value="lh dev jugyo/loophub/150" />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(writeText).toHaveBeenCalledWith("lh dev jugyo/loophub/150");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy(),
    );
  });

  it("does not throw when the clipboard API is unavailable", () => {
    vi.stubGlobal("navigator", {});
    render(<CopyButton value="x" />);
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /copy/i })),
    ).not.toThrow();
  });
});
