import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
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
  needs_human_reason: null,
  issue_number: 42,
  pr_number: 99,
  created_at: "2026-07-10T00:00:00Z",
  updated_at: "2026-07-10T01:00:00Z",
  latest_review: null,
  verification_status: "unverified",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowRunStatusSection
        owner="me"
        repo="loophub"
        state={RUN}
        showHistory
      />
    </QueryClientProvider>,
  );
}

describe("Workflow run history dialog", () => {
  it("fetches on open and shows metadata and separate rework step events", async () => {
    const fetchMock = mockRpcFetch({
      "workflowRuns/history": () => [
        {
          id: 1,
          type: "workflow_run.started",
          label: "Run started",
          description: "Workflow run #7 started.",
          routine: false,
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
          routine: false,
          input:
            "Launch Workflow execute step for run #7.\n\n## Inputs\n- repo: me/loophub\n- issue: #42\n- pr: #99",
          step: "execute",
          actor: "execute-agent-1",
          created_at: "2026-07-10T00:10:00Z",
        },
        {
          id: 3,
          type: "workflow_step.launched",
          label: "Execute step started",
          description: "Execute step execution started.",
          routine: false,
          input:
            "Launch Workflow execute step for run #7.\n\n## Inputs\n- repo: me/loophub\n- issue: #42\n- pr: #99\n\n## Note from parent\nAddress review #12.",
          step: "execute",
          actor: "execute-agent-2",
          created_at: "2026-07-10T00:30:00Z",
        },
      ],
    });
    renderSection(fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View history" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Workflow run #7 history",
    });
    expect(within(dialog).getByText("standard · run #7")).toBeTruthy();
    expect(within(dialog).getByText("Current step")).toBeTruthy();
    expect(within(dialog).getByText("Rework count")).toBeTruthy();
    expect(within(dialog).getByText("Started")).toBeTruthy();
    expect(within(dialog).getByText("Updated")).toBeTruthy();
    expect(
      await within(dialog).findAllByText("Execute step started"),
    ).toHaveLength(2);
    expect(within(dialog).getByText("Actor: execute-agent-1")).toBeTruthy();
    expect(within(dialog).getByText("Actor: execute-agent-2")).toBeTruthy();
    expect(within(dialog).getAllByText("Agent input")).toHaveLength(2);
    expect(within(dialog).getByText(/Address review #12/)).toBeTruthy();
    const runStarted = within(dialog).getByText("Run started").closest("li");
    expect(runStarted).not.toBeNull();
    expect(
      within(runStarted as HTMLElement).getByText("Step: N/A"),
    ).toBeTruthy();
    expect(rpcCall("workflowRuns/history")?.params).toMatchObject({
      repo: "me/loophub",
      run: 7,
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows loading and failure states and closes with the button", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    renderSection(
      mockRpcFetch({
        "workflowRuns/history": () => pending,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "View history" }));
    expect(
      await screen.findByText(/Loading Workflow run history/),
    ).toBeTruthy();

    reject(new RpcFault(500, "database unavailable"));
    expect(
      await screen.findByText(/Failed to load Workflow run history/),
    ).toBeTruthy();
    expect(screen.getByText(/database unavailable/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Close Workflow run history" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("plays routine bookkeeping down to one line and leaves other events intact", async () => {
    renderSection(
      mockRpcFetch({
        "workflowRuns/history": () => [
          {
            id: 1,
            type: "workflow_run.turn_done",
            label: "Turn done declared",
            description:
              "Execute declared its turn done. The parent observes HEAD and review state before any transition.",
            routine: true,
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
            routine: false,
            input: null,
            step: "execute",
            actor: "escalating-agent",
            created_at: "2026-07-10T00:10:00Z",
          },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "View history" }));

    const escalated = (
      await screen.findByText("Human guidance requested")
    ).closest("li");
    expect(escalated?.getAttribute("data-routine")).toBe("false");
    expect(
      within(escalated as HTMLElement).getByText(/criteria conflict/),
    ).toBeTruthy();
    expect(
      within(escalated as HTMLElement).getByText("Actor: escalating-agent"),
    ).toBeTruthy();

    // A routine event keeps only its label and timestamp: its description restates the label and
    // its type / step / actor repeat on every turn's copy of the same row.
    const turnDone = screen.getByText("Turn done declared").closest("li");
    expect(turnDone?.getAttribute("data-routine")).toBe("true");
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
        "workflowRuns/history": () => [],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "View history" }));
    expect(
      await screen.findByText(
        "No lifecycle events have been recorded for this run.",
      ),
    ).toBeTruthy();
  });
});
