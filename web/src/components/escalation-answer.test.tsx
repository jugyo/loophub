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

  it("submits a free answer written instead of an option, trimmed", () => {
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
    const free = screen.getByRole("textbox", { name: "Free answer" });

    fireEvent.change(free, { target: { value: "   " } });
    expect(
      (screen.getByRole("radio", { name: "Other" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(free, { target: { value: "  Neither; ask the owner " } });
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledWith("Neither; ask the owner");
  });

  it("submits the picked option even after a free answer was typed", () => {
    const onSubmit = vi.fn();
    render(
      <EscalationAnswer
        commentId={7}
        escalation={OPEN}
        submitting={false}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Free answer" }), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Keep the spec" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    expect(onSubmit).toHaveBeenCalledWith("Keep the spec");
  });

  it("shows a free answer read-only under a checked Other", () => {
    render(
      <EscalationAnswer
        commentId={7}
        escalation={{
          ...OPEN,
          answer: "Neither; ask the owner",
          answered_at: "2026-11-06T00:00:00Z",
        }}
        submitting={false}
        onSubmit={vi.fn()}
      />,
    );

    const other = screen.getByRole("radio", { name: "Other" });
    expect((other as HTMLInputElement).checked).toBe(true);
    const free = screen.getByRole("textbox", {
      name: "Free answer",
    }) as HTMLTextAreaElement;
    expect(free.value).toBe("Neither; ask the owner");
    expect(free.readOnly).toBe(true);
    fireEvent.change(free, { target: { value: "changed" } });
    expect(free.value).toBe("Neither; ask the owner");
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
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
    // Not disabled: a browser greys a disabled radio until its checked dot is barely visible.
    expect((chosen as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Change the spec" }));
    expect((chosen as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
  });

  it("keeps an answered escalation's option checked and enabled once superseded", () => {
    render(
      <EscalationAnswer
        commentId={7}
        escalation={{
          ...OPEN,
          answer: "Keep the spec",
          answered_at: "2026-11-06T00:00:00Z",
          superseded: true,
        }}
        submitting={false}
        onSubmit={vi.fn()}
      />,
    );

    const chosen = screen.getByRole("radio", { name: "Keep the spec" });
    expect((chosen as HTMLInputElement).checked).toBe(true);
    expect((chosen as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText("Answered")).toBeTruthy();
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
    expect(screen.queryByRole("textbox", { name: "Free answer" })).toBeNull();
    expect(screen.getByText("Superseded by a newer escalation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
  });
});
