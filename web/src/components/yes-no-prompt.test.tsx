import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YesNoPrompt } from "./yes-no-prompt";

afterEach(cleanup);

describe("YesNoPrompt", () => {
  it("shows the question and reports each answer to its caller", () => {
    const onYes = vi.fn();
    const onNo = vi.fn();
    render(
      <YesNoPrompt
        question="Over budget. Increase to $40.00?"
        onYes={onYes}
        onNo={onNo}
      />,
    );

    // The question also names the group, so several prompts on one page stay distinguishable.
    expect(
      screen.getByRole("group", { name: "Over budget. Increase to $40.00?" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onYes).toHaveBeenCalledTimes(1);
    expect(onNo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onNo).toHaveBeenCalledTimes(1);
  });

  it("disables both answers while the yes action is in flight", () => {
    const onYes = vi.fn();
    render(
      <YesNoPrompt question="Retry?" onYes={onYes} onNo={vi.fn()} pending />,
    );

    const yes = screen.getByRole("button", { name: "Yes" });
    expect(yes.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "No" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(yes);
    expect(onYes).not.toHaveBeenCalled();
  });
});
