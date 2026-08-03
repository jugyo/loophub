import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrSessions, WorkflowRunState } from "@/api/types";
import { HOVER_POPUP_DELAY_MS } from "@/lib/use-hover-popover";

const { focusHerdrAgent } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
}));
vi.mock("@/queries/terminal", () => ({
  useFocusHerdrAgent: () => ({
    mutate: focusHerdrAgent,
    isPending: false,
  }),
}));

import { WorkflowStepTracker } from "./workflow-step-tracker";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  focusHerdrAgent.mockClear();
});

function state(partial: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    id: 1,
    workflow_id: 1,
    workflow_name: "workflow",
    status: "running",
    current_step: "execute",
    rework_count: 0,
    rework_limit: 8,
    cost_increment_usd: 30,
    cost_limit_usd: 30,
    cost_limit_increase_available: false,
    needs_human_reason: null,
    issue_number: 5,
    pr_number: 10,
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
    latest_review: null,
    verification_status: "unverified",
    done: false,
    merge_conflict: false,
    ...partial,
  };
}

const herdrSessions: HerdrSessions = {
  repos: [
    {
      repo: "me/proj",
      session_name: "lh-me-proj",
      agents: [
        {
          id: "w1:p-parent-9",
          name: "orchestrator #9",
          status: "working",
          pull: 10,
          pull_closed: false,
          focusable: true,
          workflow: {
            kind: "parent",
            runId: 9,
          },
        },
        {
          id: "w1:p0",
          name: "orchestrator #1",
          status: "working",
          pull: 10,
          pull_closed: false,
          focusable: true,
          workflow: {
            kind: "parent",
            runId: 1,
          },
        },
        {
          id: "w1:p1",
          name: "executor #1-1",
          status: "done",
          pull: 10,
          pull_closed: false,
          focusable: true,
          workflow: {
            kind: "step",
            runId: 1,
            step: "execute",
            sequence: 1,
          },
        },
        {
          id: "w1:p3",
          name: "executor #1-3",
          status: "working",
          pull: 10,
          pull_closed: false,
          focusable: true,
          workflow: {
            kind: "step",
            runId: 1,
            step: "execute",
            sequence: 3,
          },
        },
        {
          id: "synthetic",
          name: "verifier #1-4",
          status: "working",
          pull: 10,
          pull_closed: false,
          focusable: false,
          workflow: {
            kind: "step",
            runId: 1,
            step: "verify",
            sequence: 4,
          },
        },
        {
          id: "w1:p9",
          name: "executor #9-1",
          status: "working",
          pull: 10,
          pull_closed: false,
          focusable: true,
          workflow: {
            kind: "step",
            runId: 9,
            step: "execute",
            sequence: 1,
          },
        },
      ],
      pull_workspaces: [],
      issue_workspaces: [],
    },
  ],
};

describe("WorkflowStepTracker", () => {
  it("connects the optional parent bot to Execute and opens parent details", () => {
    vi.useFakeTimers();
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state()}
        herdrSessions={herdrSessions}
        showWorkflowNode
      />,
    );

    const workflow = screen.getByRole("button", { name: "Workflow" });
    const parentBot = workflow.querySelector("[data-agent-bot-icon]");
    expect(parentBot).toBeTruthy();
    expect(parentBot?.className).toContain("linked-pull-pulse");
    expect(workflow.tagName).toBe("BUTTON");
    const node = workflow.parentElement!;
    const connector = node.nextElementSibling;
    expect(connector?.getAttribute("data-workflow-connector")).toBe(
      "workflow-execute",
    );
    expect(
      connector?.nextElementSibling?.getAttribute("data-workflow-stage"),
    ).toBe("execute");

    fireEvent.mouseEnter(node);
    act(() => vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS));
    const dialog = screen.getByRole("dialog", { name: "Workflow details" });
    expect(dialog.textContent).toContain("workflow");
    expect(dialog.textContent).toContain("Run #1");
    expect(dialog.textContent).toContain("working");
    expect(within(dialog).getByText("Open in Herdr")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open in Herdr" }),
    );
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p0" },
      expect.anything(),
    );
  });

  it("keeps the parent bot static when the parent agent is not working", () => {
    const sessions: HerdrSessions = {
      ...herdrSessions,
      repos: herdrSessions.repos.map((repo) => ({
        ...repo,
        agents: repo.agents.map((agent) =>
          agent.workflow?.kind === "parent" && agent.workflow.runId === 1
            ? { ...agent, status: "done" }
            : agent,
        ),
      })),
    };
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state()}
        herdrSessions={sessions}
        showWorkflowNode
      />,
    );

    const parentBot = screen
      .getByRole("button", { name: "Workflow" })
      .querySelector("[data-agent-bot-icon]");
    expect(parentBot).toBeTruthy();
    expect(parentBot?.className).not.toContain("linked-pull-pulse");
  });

  it("animates a working parent bot without offering a non-focusable pane action", () => {
    const sessions: HerdrSessions = {
      ...herdrSessions,
      repos: herdrSessions.repos.map((repo) => ({
        ...repo,
        agents: repo.agents.map((agent) =>
          agent.workflow?.kind === "parent" && agent.workflow.runId === 1
            ? { ...agent, focusable: false }
            : agent,
        ),
      })),
    };
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state()}
        herdrSessions={sessions}
        showWorkflowNode
      />,
    );

    const workflow = screen.getByRole("button", { name: "Workflow" });
    expect(
      workflow.querySelector("[data-agent-bot-icon]")?.className,
    ).toContain("linked-pull-pulse");
    fireEvent.focus(workflow);
    const dialog = screen.getByRole("dialog", { name: "Workflow details" });
    expect(dialog.textContent).toContain("working");
    expect(
      within(dialog).queryByRole("button", { name: "Open in Herdr" }),
    ).toBeNull();
  });

  it("keeps shared tracker surfaces unchanged unless the workflow node is requested", () => {
    render(<WorkflowStepTracker state={state()} />);

    expect(screen.queryByLabelText("Workflow")).toBeNull();
    expect(
      document.querySelector('[data-workflow-connector="workflow-execute"]'),
    ).toBeNull();
  });

  it("never offers a stale parent action when Herdr data is unavailable", () => {
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state()}
        herdrSessions={herdrSessions}
        herdrUnavailable
        showWorkflowNode
      />,
    );

    fireEvent.focus(screen.getByLabelText("Workflow"));
    const dialog = screen.getByRole("dialog", { name: "Workflow details" });
    expect(dialog.textContent).toContain("Herdr pane data is unavailable.");
    expect(
      within(dialog).queryByRole("button", { name: "Open in Herdr" }),
    ).toBeNull();
  });

  it("opens an identifying popup for every stage on hover", () => {
    vi.useFakeTimers();
    render(<WorkflowStepTracker state={state()} />);

    for (const label of ["Execute", "Verify", "Done"]) {
      const pill = screen.getByText(label);
      fireEvent.mouseEnter(pill.parentElement!);
      act(() => vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS));

      const dialog = screen.getByRole("dialog", {
        name: `${label} workflow step details`,
      });
      expect(dialog.textContent).toContain(`${label} step`);
      expect(dialog.textContent).toContain("Run #1");

      fireEvent.mouseLeave(pill.parentElement!);
      expect(
        screen.queryByRole("dialog", {
          name: `${label} workflow step details`,
        }),
      ).toBeNull();
    }
  });

  it("opens the latest matching focusable step pane and offers no wrong action", () => {
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state()}
        herdrSessions={herdrSessions}
      />,
    );

    fireEvent.focus(screen.getByText("Execute"));
    const executeDialog = screen.getByRole("dialog", {
      name: "Execute workflow step details",
    });
    fireEvent.click(
      within(executeDialog).getByRole("button", { name: "Open in Herdr" }),
    );
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p3" },
      expect.anything(),
    );

    fireEvent.blur(screen.getByText("Execute"));
    fireEvent.focus(screen.getByText("Verify"));
    expect(
      within(
        screen.getByRole("dialog", {
          name: "Verify workflow step details",
        }),
      ).queryByRole("button", { name: "Open in Herdr" }),
    ).toBeNull();

    fireEvent.blur(screen.getByText("Verify"));
    fireEvent.focus(screen.getByText("Done"));
    expect(
      within(
        screen.getByRole("dialog", {
          name: "Done workflow step details",
        }),
      ).queryByRole("button", { name: "Open in Herdr" }),
    ).toBeNull();
  });

  it("shows why pane actions are unavailable when the Herdr snapshot fails", () => {
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state()}
        herdrUnavailable
      />,
    );

    const execute = screen.getByText("Execute");
    expect(execute.className).toContain("focus-visible:ring-2");
    fireEvent.focus(execute);
    const dialog = screen.getByRole("dialog", {
      name: "Execute workflow step details",
    });
    expect(dialog.textContent).toContain("Herdr pane data is unavailable.");
    expect(
      within(dialog).queryByRole("button", { name: "Open in Herdr" }),
    ).toBeNull();
  });

  it("keeps the popup open while pointer or keyboard focus moves to its action", () => {
    vi.useFakeTimers();
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state()}
        herdrSessions={herdrSessions}
      />,
    );
    const execute = screen.getByText("Execute");
    const stage = execute.parentElement!;

    fireEvent.mouseEnter(stage);
    act(() => vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS));
    const dialog = screen.getByRole("dialog", {
      name: "Execute workflow step details",
    });
    fireEvent.mouseLeave(stage, { relatedTarget: dialog });
    expect(
      screen.getByRole("dialog", {
        name: "Execute workflow step details",
      }),
    ).toBeTruthy();

    fireEvent.mouseLeave(stage);
    fireEvent.focus(execute);
    const button = screen.getByRole("button", { name: "Open in Herdr" });
    fireEvent.blur(execute, { relatedTarget: button });
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(
      screen.getByRole("dialog", {
        name: "Execute workflow step details",
      }),
    ).toBeTruthy();

    fireEvent.keyDown(button, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", {
        name: "Execute workflow step details",
      }),
    ).toBeNull();
  });

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
          done: true,
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
          done: true,
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
          done: true,
        })}
        working
      />,
    );
    // Done is terminal, so it must not carry the working glow.
    expect(screen.getByText("Done").className).not.toContain(
      "workflow-stage-glow",
    );
  });

  it("does not glow the terminal Conflict pill while working", () => {
    render(
      <WorkflowStepTracker
        state={state({
          current_step: "verify",
          verification_status: "verified",
          done: false,
          merge_conflict: true,
        })}
        working
      />,
    );
    expect(screen.getByText("Conflict!").className).not.toContain(
      "workflow-stage-glow",
    );
  });

  it("keeps the Verify label plain when verification is stale (#1906)", () => {
    render(
      <WorkflowStepTracker
        state={state({ current_step: "verify", verification_status: "stale" })}
      />,
    );
    const verify = screen.getByText("Verify");
    // The label spends no width on the reason; the amber tone and the popover status carry it.
    expect(verify.textContent).toBe("Verify");
    expect(verify.className).toContain("amber");
    fireEvent.focus(verify);
    expect(
      screen.getByRole("dialog", { name: "Verify workflow step details" })
        .textContent,
    ).toContain("Reverify required");
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
        state={state({ current_step: "execute", merge_conflict: true })}
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
    render(<WorkflowStepTracker state={state({ current_step: "execute" })} />);
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByText("Conflict!")).toBeNull();
  });

  it("lets a conflict override the verified-green Done pill", () => {
    render(
      <WorkflowStepTracker
        state={state({
          current_step: "verify",
          verification_status: "verified",
          done: false,
          merge_conflict: true,
        })}
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

  it("drops the needs-human marker when the caller marks the run over budget (#1932)", () => {
    render(
      <WorkflowStepTracker
        state={state({
          current_step: "verify",
          needs_human_reason: "Cost limit exceeded",
        })}
        overBudget
      />,
    );
    expect(screen.queryByText("needs human")).toBeNull();
    // Only the marker goes: the pipeline and the step's needs-human status stay.
    expect(screen.getByText("Verify")).toBeTruthy();
    fireEvent.focus(screen.getByText("Verify"));
    expect(screen.getByText("Needs human")).toBeTruthy();
  });

  it("always shows step bots and only animates stages whose latest agent is working", () => {
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state({ current_step: "verify" })}
        herdrSessions={herdrSessions}
      />,
    );
    // Both latest step agents are working, independently of the domain's current step.
    expect(screen.getByText("Verify").className).toContain(
      "animate-[workflow-stage-glow",
    );
    expect(screen.getByText("Execute").className).toContain(
      "animate-[workflow-stage-glow",
    );
    expect(screen.getByText("Done").className).not.toContain(
      "workflow-stage-glow",
    );
    expect(
      screen.getByRole("img", { name: "Execute agent working" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Verify agent working" }),
    ).toBeTruthy();
  });

  it("stays static when the agent is not working", () => {
    render(<WorkflowStepTracker state={state({ current_step: "verify" })} />);
    expect(screen.getByText("Verify").className).not.toContain(
      "workflow-stage-glow",
    );
    expect(
      screen.getByRole("img", { name: "Execute agent" }).className,
    ).not.toContain("linked-pull-pulse");
    expect(
      screen.getByRole("img", { name: "Verify agent" }).className,
    ).not.toContain("linked-pull-pulse");
  });

  it("ignores an older working attempt when the latest step agent has stopped", () => {
    const sessions: HerdrSessions = {
      repos: [
        {
          repo: "me/proj",
          session_name: "lh-me-proj",
          agents: [
            {
              id: "w1:p1",
              name: "executor #1-1",
              status: "working",
              pull: 10,
              pull_closed: false,
              focusable: true,
              workflow: {
                kind: "step",
                runId: 1,
                step: "execute",
                sequence: 1,
              },
            },
            {
              id: "w1:p2",
              name: "executor #1-2",
              status: "done",
              pull: 10,
              pull_closed: false,
              focusable: true,
              workflow: {
                kind: "step",
                runId: 1,
                step: "execute",
                sequence: 2,
              },
            },
          ],
          pull_workspaces: [],
          issue_workspaces: [],
        },
      ],
    };
    render(
      <WorkflowStepTracker
        owner="me"
        repo="proj"
        state={state()}
        herdrSessions={sessions}
      />,
    );
    expect(screen.getByText("Execute").className).not.toContain(
      "workflow-stage-glow",
    );
    expect(screen.getByRole("img", { name: "Execute agent" })).toBeTruthy();
  });

  it("does not render merge-ready Done styling while any PR agent is working", () => {
    render(
      <WorkflowStepTracker
        state={state({ verification_status: "verified", done: true })}
        working
      />,
    );
    const done = screen.getByText("Done");
    expect(done.className).not.toContain("text-green");
    expect(done.querySelector("svg")).toBeNull();
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
