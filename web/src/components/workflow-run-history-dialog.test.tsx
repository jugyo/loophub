import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { WorkflowRunState } from "@/api/types";
import { WorkflowRunStatusSection } from "./workflow-run-status";

const RUN: WorkflowRunState = {
  id: 7,
  workflow_id: 3,
  workflow_name: "standard",
  status: "running",
  current_step: "execute",
  rework_count: 1,
  rework_limit: 8,
  cost_increment_usd: 30,
  cost_limit_usd: 30,
  cost_limit_increase_available: false,
  needs_human_reason: null,
  issue_number: 42,
  pr_number: 99,
  created_at: "2026-07-10T00:00:00Z",
  updated_at: "2026-07-10T01:00:00Z",
  ended_at: null,
  latest_review: null,
  verification_status: "unverified",
  pr_merged: false,
  done: false,
  merge_conflict: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection(fetchImpl: typeof fetch, state: WorkflowRunState = RUN) {
  vi.stubGlobal("fetch", fetchImpl);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={state}
        showDetail
      />
    </QueryClientProvider>,
  );
}

describe("Workflow run detail dialog", () => {
  it("fetches on open and shows agent costs, metadata, and history", async () => {
    const fetchMock = mockRpcFetch({
      "workflowRuns/totalCost": () => ({
        cost_usd: 1.25,
        cost_status: "partial",
      }),
      "workflowRuns/agentCosts": () => [
        {
          role: "parent",
          session_count: 1,
          known_session_count: 1,
          pending_session_count: 0,
          unknown_session_count: 0,
          cost_usd: 1.25,
        },
        {
          role: "execute",
          session_count: 4,
          known_session_count: 2,
          pending_session_count: 1,
          unknown_session_count: 1,
          cost_usd: 0.75,
        },
        {
          role: "verify",
          session_count: 1,
          known_session_count: 0,
          pending_session_count: 0,
          unknown_session_count: 1,
          cost_usd: 0,
        },
      ],
      "workflowRuns/history": () => [
        {
          id: 1,
          type: "workflow_run.started",
          label: "Run started",
          description: "Workflow run 7 started.",
          significance: "default",
          input: null,
          step: null,
          actor: "parent-agent",
          created_at: "2026-07-10T00:00:00Z",
        },
        {
          id: 2,
          type: "workflow_step.launched",
          label: "Execute step started",
          description: "Execute step execution started.",
          significance: "default",
          input:
            "Launch Workflow execute step for run 7.\n\n## Inputs\n- repo: me/loophub\n- issue: #42\n- pr: #99",
          step: "execute",
          actor: "execute-agent-1",
          created_at: "2026-07-10T00:10:00Z",
        },
        {
          id: 3,
          type: "workflow_step.launched",
          label: "Execute step started",
          description: "Execute step execution started.",
          significance: "default",
          input:
            "Launch Workflow execute step for run 7.\n\n## Inputs\n- repo: me/loophub\n- issue: #42\n- pr: #99\n\n## Note from parent\nAddress review 12.",
          step: "execute",
          actor: "execute-agent-2",
          created_at: "2026-07-10T00:30:00Z",
        },
      ],
    });
    renderSection(fetchMock);

    await waitFor(() =>
      expect(rpcCall("workflowRuns/totalCost")?.params).toMatchObject({
        repo: "me/loophub",
        run: 7,
      }),
    );
    expect(rpcCall("workflowRuns/history")).toBeUndefined();
    expect(rpcCall("workflowRuns/agentCosts")).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Workflow run 7 detail",
    });
    expect(within(dialog).getByText("standard · run 7")).toBeTruthy();
    expect(within(dialog).getByText("Current step")).toBeTruthy();
    expect(within(dialog).getByText("Execute")).toBeTruthy();
    expect(within(dialog).getByText("Rework")).toBeTruthy();
    expect(within(dialog).getByText("1/8")).toBeTruthy();
    expect(within(dialog).getByText("Started")).toBeTruthy();
    expect(within(dialog).getByText("Updated")).toBeTruthy();
    const agentCosts = within(dialog)
      .getByText("Agents")
      .closest("section") as HTMLElement;
    await within(agentCosts).findByText("Parent");
    const rows = within(agentCosts).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("Parent")).toBeTruthy();
    expect(within(rows[0]).getByText("1 session")).toBeTruthy();
    expect(within(rows[0]).getByText("$1.25")).toBeTruthy();
    expect(within(rows[1]).getByText("Execute")).toBeTruthy();
    expect(within(rows[1]).getByText("4 sessions")).toBeTruthy();
    expect(within(rows[1]).getByText("$0.75 known")).toBeTruthy();
    expect(within(rows[1]).getByText("1 pending · 1 unknown")).toBeTruthy();
    expect(within(rows[2]).getByText("Verify")).toBeTruthy();
    expect(within(rows[2]).getByText("Unknown")).toBeTruthy();
    expect(
      await within(dialog).findAllByText("Execute step started"),
    ).toHaveLength(2);
    expect(within(dialog).getByText("Actor: execute-agent-1")).toBeTruthy();
    expect(within(dialog).getByText("Actor: execute-agent-2")).toBeTruthy();
    const inputSummaries = within(dialog).getAllByText("Agent input");
    expect(inputSummaries).toHaveLength(2);
    // Agent input is collapsed by default and expands on demand.
    const inputDetails = inputSummaries.map((summary) =>
      summary.closest("details"),
    );
    for (const details of inputDetails) {
      expect(details).not.toBeNull();
      expect((details as HTMLDetailsElement).open).toBe(false);
    }
    expect(within(dialog).getByText(/Address review 12/)).toBeTruthy();
    fireEvent.click(inputSummaries[1] as HTMLElement);
    expect((inputDetails[1] as HTMLDetailsElement).open).toBe(true);
    const runStarted = within(dialog).getByText("Run started").closest("li");
    expect(runStarted).not.toBeNull();
    expect(
      within(runStarted as HTMLElement).getByText("Step: N/A"),
    ).toBeTruthy();
    expect(rpcCall("workflowRuns/history")?.params).toMatchObject({
      repo: "me/loophub",
      run: 7,
    });
    expect(rpcCall("workflowRuns/agentCosts")?.params).toMatchObject({
      repo: "me/loophub",
      run: 7,
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows Done as the current step after the PR is merged (#265, PR #242)", async () => {
    renderSection(
      mockRpcFetch({
        "workflowRuns/agentCosts": () => [],
        "workflowRuns/history": () => [],
      }),
      {
        ...RUN,
        status: "running",
        current_step: "verify",
        pr_merged: true,
        needs_human_reason: "waiting for a decision",
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Workflow run 7 detail",
    });
    const currentStep = within(dialog).getByText("Current step").parentElement;
    expect(currentStep).not.toBeNull();
    expect(within(dialog).getByText("Completed")).toBeTruthy();
    expect(within(dialog).queryByText("Running")).toBeNull();
    expect(within(dialog).queryByText("Needs human")).toBeNull();
    expect(within(currentStep as HTMLElement).getByText("Done")).toBeTruthy();
    expect(within(currentStep as HTMLElement).queryByText("Verify")).toBeNull();
  });

  it("shows loading and failure states and closes with the button", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    renderSection(
      mockRpcFetch({
        "workflowRuns/agentCosts": () => [],
        "workflowRuns/history": () => pending,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));
    expect(
      await screen.findByText(/Loading Workflow run history/),
    ).toBeTruthy();

    reject(new RpcFault(500, "database unavailable"));
    expect(
      await screen.findByText(/Failed to load Workflow run history/),
    ).toBeTruthy();
    expect(screen.getByText(/database unavailable/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Close Workflow run detail" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // #2348: the PR sidebar that renders this section is a sticky box, and sticky creates a stacking
  // context, so an overlay left inside the section can only stack against the section's siblings —
  // the app shell's sticky header and toasts would then draw over the modal.
  it("renders the overlay outside the section that opened it", async () => {
    const { container } = renderSection(
      mockRpcFetch({
        "workflowRuns/agentCosts": () => [],
        "workflowRuns/history": () => [],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));

    const dialog = await screen.findByRole("dialog");
    const overlay = dialog.parentElement;
    expect(overlay?.className).toContain("fixed");
    expect(container.contains(overlay)).toBe(false);
    expect(overlay?.parentElement).toBe(document.body);
  });

  it("keeps agent cost loading, failure, and empty states visible", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    renderSection(
      mockRpcFetch({
        "workflowRuns/agentCosts": () => pending,
        "workflowRuns/history": () => [],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));
    expect(await screen.findByText(/Loading agent costs/)).toBeTruthy();

    reject(new RpcFault(500, "usage unavailable"));
    expect(await screen.findByText(/Failed to load agent costs/)).toBeTruthy();
    expect(screen.getByText(/usage unavailable/)).toBeTruthy();

    cleanup();
    renderSection(
      mockRpcFetch({
        "workflowRuns/agentCosts": () => [],
        "workflowRuns/history": () => [],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));
    expect(
      await screen.findByText(
        "No agent sessions have been recorded for this run.",
      ),
    ).toBeTruthy();
  });

  it("ranks entries by significance: notable stands out, routine plays down", async () => {
    renderSection(
      mockRpcFetch({
        "workflowRuns/agentCosts": () => [],
        "workflowRuns/history": () => [
          {
            id: 1,
            type: "workflow_run.turn_done",
            label: "Turn done declared",
            description:
              "Execute declared its turn done. The parent observes HEAD and review state before any transition.",
            significance: "routine",
            input: null,
            step: "execute",
            actor: "execute-agent",
            created_at: "2026-07-10T00:00:00Z",
          },
          {
            id: 2,
            type: "workflow_run.escalated",
            label: "Human guidance requested",
            description: "Execute requested human guidance: criteria conflict.",
            significance: "notable",
            input: null,
            step: "execute",
            actor: "escalating-agent",
            created_at: "2026-07-10T00:10:00Z",
          },
          {
            id: 3,
            type: "workflow_run.started",
            label: "Run started",
            description: "Workflow run 7 started.",
            significance: "default",
            input: null,
            step: null,
            actor: "parent-agent",
            created_at: "2026-07-10T00:20:00Z",
          },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));

    const escalated = (
      await screen.findByText("Human guidance requested")
    ).closest("li");
    expect(escalated?.getAttribute("data-significance")).toBe("notable");
    expect(
      within(escalated as HTMLElement).getByText(/criteria conflict/),
    ).toBeTruthy();
    expect(
      within(escalated as HTMLElement).getByText("Actor: escalating-agent"),
    ).toBeTruthy();

    // A notable entry outweighs a default one by weight and size, not by color alone.
    const notableTitle = screen.getByText("Human guidance requested");
    const defaultTitle = screen.getByText("Run started");
    expect(notableTitle.className).toContain("text-base");
    expect(notableTitle.className).toContain("font-semibold");
    expect(defaultTitle.className).toContain("text-sm");
    expect(defaultTitle.className).toContain("font-medium");
    expect(
      (defaultTitle.closest("li") as HTMLElement).getAttribute(
        "data-significance",
      ),
    ).toBe("default");

    // A routine event keeps only its label and timestamp: its description restates the label and
    // its type / step / actor repeat on every turn's copy of the same row.
    const turnDone = screen.getByText("Turn done declared").closest("li");
    expect(turnDone?.getAttribute("data-significance")).toBe("routine");
    expect(
      within(turnDone as HTMLElement).queryByText(/observes HEAD/),
    ).toBeNull();
    expect(
      within(turnDone as HTMLElement).queryByText("Actor: execute-agent"),
    ).toBeNull();
  });

  it("shows an empty state when the run has no persisted lifecycle events", async () => {
    renderSection(
      mockRpcFetch({
        "workflowRuns/agentCosts": () => [],
        "workflowRuns/history": () => [],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));
    expect(
      await screen.findByText(
        "No lifecycle events have been recorded for this run.",
      ),
    ).toBeTruthy();
  });
});
