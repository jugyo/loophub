import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@/api/types";
import { WorkflowStepTracker } from "./workflow-step-tracker";

afterEach(cleanup);

function state(partial: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    id: 1,
    workflow_id: 1,
    workflow_name: "workflow",
    status: "running",
    current_step: "execute",
    rework_count: 0,
    needs_human_reason: null,
    issue_number: 5,
    pr_number: 10,
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
    latest_review: null,
    verification_status: "unverified",
    ...partial,
  };
}

describe("WorkflowStepTracker", () => {
  it("shows Execute → Verify → Done and colors only the current stage", () => {
    render(<WorkflowStepTracker state={state({ current_step: "execute" })} />);
    const execute = screen.getByText("Execute");
    const verify = screen.getByText("Verify");
    const done = screen.getByText("Done");
    // Current stage is highlighted (primary), the rest are grey.
    expect(execute.getAttribute("aria-current")).toBe("step");
    expect(execute.className).toContain("text-link");
    expect(verify.getAttribute("aria-current")).toBeNull();
    expect(verify.className).toContain("text-muted-foreground");
    expect(done.getAttribute("aria-current")).toBeNull();
  });

  it("marks a passed-through stage distinctly from an upcoming one", () => {
    render(<WorkflowStepTracker state={state({ current_step: "verify" })} />);
    // Execute is behind the current Verify stage: filled (done-ish), not the muted upcoming style.
    const execute = screen.getByText("Execute");
    expect(execute.className).toContain("bg-muted");
    expect(execute.className).toContain("text-foreground");
    expect(screen.getByText("Verify").getAttribute("aria-current")).toBe(
      "step",
    );
  });

  it("lights Done green when Verify passes (terminal)", () => {
    render(
      <WorkflowStepTracker
        state={state({
          current_step: "verify",
          verification_status: "verified",
        })}
      />,
    );
    const done = screen.getByText("Done");
    expect(done.getAttribute("aria-current")).toBe("step");
    expect(done.className).toContain("text-green");
  });

  it("shows a checkmark before Done only once it is reached", () => {
    const { rerender } = render(
      <WorkflowStepTracker state={state({ current_step: "verify" })} />,
    );
    // Done not reached yet: no checkmark icon in the pill.
    expect(screen.getByText("Done").querySelector("svg")).toBeNull();
    rerender(
      <WorkflowStepTracker
        state={state({
          current_step: "verify",
          verification_status: "verified",
        })}
      />,
    );
    // Done reached: a checkmark precedes the label.
    expect(screen.getByText("Done").querySelector("svg")).toBeTruthy();
  });

  it("does not glow Done even while working once it is reached", () => {
    render(
      <WorkflowStepTracker
        state={state({
          current_step: "verify",
          verification_status: "verified",
        })}
        working
      />,
    );
    // Done is terminal, so it must not carry the working glow.
    expect(screen.getByText("Done").className).not.toContain(
      "workflow-stage-glow",
    );
  });

  it("annotates Verify with reverify when verification is stale", () => {
    render(
      <WorkflowStepTracker
        state={state({ current_step: "verify", verification_status: "stale" })}
      />,
    );
    expect(screen.getByText(/reverify/)).toBeTruthy();
    // Done is not reached: it stays grey, not green.
    expect(screen.getByText("Done").className).not.toContain("text-green");
  });

  it("does not treat a completed run as reaching Done", () => {
    render(
      <WorkflowStepTracker
        state={state({
          status: "completed",
          current_step: "verify",
          verification_status: "verified",
        })}
      />,
    );
    // `status === completed` is not the terminal signal — Done stays unreached (grey, not current).
    expect(screen.getByText("Done").className).not.toContain("text-green");
    expect(screen.getByText("Verify").getAttribute("aria-current")).toBe(
      "step",
    );
    expect(screen.getByText("Done").getAttribute("aria-current")).toBeNull();
  });

  it("flips the terminal Done pill to Conflict! in a danger tone when the PR conflicts", () => {
    render(
      <WorkflowStepTracker
        state={state({ current_step: "execute" })}
        conflict
      />,
    );
    // The terminal pill now reads "Conflict!" (danger red), not "Done".
    expect(screen.queryByText("Done")).toBeNull();
    const conflictPill = screen.getByText("Conflict!");
    expect(conflictPill.className).toContain("text-red");
    // A warning icon precedes the label.
    expect(conflictPill.querySelector("svg")).toBeTruthy();
    // Execute → Verify are untouched.
    expect(screen.getByText("Execute").getAttribute("aria-current")).toBe(
      "step",
    );
    expect(screen.getByText("Verify")).toBeTruthy();
  });

  it("keeps the plain Done pill when the PR does not conflict", () => {
    render(
      <WorkflowStepTracker
        state={state({ current_step: "execute" })}
        conflict={false}
      />,
    );
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByText("Conflict!")).toBeNull();
  });

  it("lets a conflict override the verified-green Done pill", () => {
    render(
      <WorkflowStepTracker
        state={state({
          current_step: "verify",
          verification_status: "verified",
        })}
        conflict
      />,
    );
    // Even a verified run shows Conflict! — the PR still can't merge.
    const conflictPill = screen.getByText("Conflict!");
    expect(conflictPill.className).toContain("text-red");
    expect(conflictPill.className).not.toContain("text-green");
  });

  it("appends a needs-human marker while keeping the pipeline", () => {
    render(
      <WorkflowStepTracker
        state={state({
          current_step: "verify",
          needs_human_reason: "waiting for a decision",
        })}
      />,
    );
    expect(screen.getByText("needs human")).toBeTruthy();
    expect(screen.getByText("Execute")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("glows only the current stage pill while the agent is working", () => {
    render(
      <WorkflowStepTracker state={state({ current_step: "verify" })} working />,
    );
    // The current stage (Verify) gets the slow glow; the others do not.
    expect(screen.getByText("Verify").className).toContain(
      "animate-[workflow-stage-glow",
    );
    expect(screen.getByText("Execute").className).not.toContain(
      "workflow-stage-glow",
    );
    expect(screen.getByText("Done").className).not.toContain(
      "workflow-stage-glow",
    );
  });

  it("stays static when the agent is not working", () => {
    render(<WorkflowStepTracker state={state({ current_step: "verify" })} />);
    expect(screen.getByText("Verify").className).not.toContain(
      "workflow-stage-glow",
    );
  });

  it("uses larger pills at size md", () => {
    const { rerender } = render(
      <WorkflowStepTracker state={state()} size="sm" />,
    );
    expect(screen.getByText("Execute").className).toContain("text-[11px]");
    rerender(<WorkflowStepTracker state={state()} size="md" />);
    expect(screen.getByText("Execute").className).toContain("text-xs");
  });
});
