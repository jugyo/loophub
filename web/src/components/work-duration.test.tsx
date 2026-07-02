import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkDuration } from "./work-duration";

describe("WorkDuration", () => {
  it("shows N/A when there is no dev session to anchor the calculation", () => {
    const { container } = render(
      <WorkDuration
        workDuration={{
          total: { seconds: null, basis: null },
          implementation: null,
          review: null,
        }}
      />,
    );
    expect(container.textContent).toContain("Work duration");
    expect(container.textContent).toContain("N/A");
  });

  it("shows N/A when work_duration is entirely absent (e.g. an older cached response)", () => {
    const { container } = render(<WorkDuration workDuration={undefined} />);
    expect(container.textContent).toContain("N/A");
  });

  it("renders the total with a merged basis label, plus finished implementation/review phases", () => {
    const { container } = render(
      <WorkDuration
        workDuration={{
          total: { seconds: 3661, basis: "merged" },
          implementation: { seconds: 3000, done: true },
          review: { seconds: 661, done: true },
        }}
      />,
    );
    expect(container.textContent).toContain("1h 1m (merged)");
    expect(container.textContent).toContain("Implementation: 50m");
    expect(container.textContent).toContain("Review: 11m 1s");
  });

  it("renders an in_review total that keeps growing, with a still-running review phase", () => {
    const { container } = render(
      <WorkDuration
        workDuration={{
          total: { seconds: 305, basis: "in_review" },
          implementation: { seconds: 300, done: true },
          review: { seconds: 5, done: false },
        }}
      />,
    );
    expect(container.textContent).toContain("5m 5s (in review)");
    expect(container.textContent).toContain("Implementation: 5m");
    expect(container.textContent).toContain("Review: 5s so far");
  });

  it("renders an in-progress total with no review phase yet", () => {
    const { container } = render(
      <WorkDuration
        workDuration={{
          total: { seconds: 45, basis: "in_progress" },
          implementation: { seconds: 45, done: false },
          review: null,
        }}
      />,
    );
    expect(container.textContent).toContain("45s (in progress)");
    expect(container.textContent).toContain("Implementation: 45s so far");
    expect(container.textContent).not.toContain("Review:");
  });

  it("renders a closed basis label with no review phase (never reached ready_for_review)", () => {
    const { container } = render(
      <WorkDuration
        workDuration={{
          total: { seconds: 500, basis: "closed" },
          implementation: { seconds: 500, done: true },
          review: null,
        }}
      />,
    );
    expect(container.textContent).toContain("8m 20s (closed)");
    expect(container.textContent).toContain("Implementation: 8m 20s");
    expect(container.textContent).not.toContain("Review:");
  });
});
