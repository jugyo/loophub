import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileStatusBadge } from "@/components/file-status-badge";

describe("FileStatusBadge", () => {
  it.each([
    ["added", "A", "green"],
    ["copied", "C", "violet"],
    ["modified", "M", "amber"],
    ["removed", "D", "red"],
    ["renamed", "R", "blue"],
  ])("shows %s with its semantic color", (status, label, color) => {
    render(<FileStatusBadge status={status} />);

    const badge = screen.getByLabelText(`File status: ${status}`);
    expect(badge.textContent).toBe(label);
    expect(badge.className).toContain(`border-${color}-300`);
    expect(badge.className).toContain(`bg-${color}-50`);
    expect(badge.className).toContain(`text-${color}-700`);
  });

  it("keeps unknown statuses neutral", () => {
    render(<FileStatusBadge status="unknown" />);

    const badge = screen.getByLabelText("File status: unknown");
    expect(badge.textContent).toBe("u");
    expect(badge.className).toContain("bg-muted");
    expect(badge.className).toContain("text-muted-foreground");
  });
});
