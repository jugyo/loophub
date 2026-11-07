import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "#loophub-test";
import { EscalationAnswer } from "./escalation-answer";

afterEach(() => cleanup());

const OPEN = {
  options: ["Keep the spec", "Change the spec"],
  answer: null,
  answered_at: null,
  superseded: false,
};

describe("EscalationAnswer", () => {
  it("submits the one option picked from the radio buttons", () => {
    const onSubmit = vi.fn();
    render(
      <EscalationAnswer
        commentId={7}
        escalation={OPEN}
        submitting={false}
        onSubmit={onSubmit}
      />,
    );
    const submit = screen.getByRole("button", { name: "Submit answer" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "Change the spec" }));
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledWith("Change the spec");
  });

  it("shows the chosen option of an answered escalation without a submit", () => {
    render(
      <EscalationAnswer
        commentId={7}
        escalation={{
          ...OPEN,
          answer: "Keep the spec",
          answered_at: "2026-11-06T00:00:00Z",
        }}
        submitting={false}
        onSubmit={vi.fn()}
      />,
    );

    const chosen = screen.getByRole("radio", { name: "Keep the spec" });
    expect((chosen as HTMLInputElement).checked).toBe(true);
    expect((chosen as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
  });

  it("disables a superseded escalation", () => {
    render(
      <EscalationAnswer
        commentId={7}
        escalation={{ ...OPEN, superseded: true }}
        submitting={false}
        onSubmit={vi.fn()}
      />,
    );

    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByText("Superseded by a newer escalation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
  });
});
