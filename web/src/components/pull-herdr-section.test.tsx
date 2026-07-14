import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrSessions } from "@/api/types";

const { focusHerdrAgent, showError } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
  showError: vi.fn(),
}));
const herdrSessions = vi.hoisted(() => ({
  value: undefined as HerdrSessions | undefined,
  isError: false,
  focusPending: false,
}));
vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError }),
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({
    data: herdrSessions.value,
    isError: herdrSessions.isError,
  }),
  useFocusHerdrAgent: () => ({
    mutate: focusHerdrAgent,
    isPending: herdrSessions.focusPending,
  }),
}));

import { PullHerdrSection } from "./pull-herdr-section";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  focusHerdrAgent.mockClear();
  showError.mockClear();
  herdrSessions.value = undefined;
  herdrSessions.isError = false;
  herdrSessions.focusPending = false;
});

const running: HerdrSessions = {
  repos: [
    {
      repo: "me/proj",
      session_name: "lh-me-proj",
      agents: [
        {
          id: "w1:p1",
          name: "orchestrator #7",
          status: "working",
          pull: 42,
          pull_closed: false,
          focusable: true,
          workflow: { kind: "parent", runId: 7 },
          session: {
            id: "parent-session",
            agent: "workflow-parent",
            runtime: "codex",
            kind: "workflow-parent",
            usage: {
              sessions_with_usage: 1,
              input_tokens: 100,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
              output_tokens: 50,
              total_tokens: 200,
              cost_usd: 1.25,
              has_unknown_cost: false,
              context_usage_percent: 12,
            },
          },
        },
        {
          id: "w1:p2",
          name: "executor #7-1",
          status: "done",
          pull: 42,
          pull_closed: false,
          focusable: true,
          workflow: {
            kind: "step",
            runId: 7,
            step: "execute",
            sequence: 1,
          },
          session: {
            id: "execute-session",
            agent: "workflow-step",
            runtime: "codex",
            kind: "workflow-step",
            usage: {
              sessions_with_usage: 0,
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              cost_usd: null,
              has_unknown_cost: false,
              context_usage_percent: null,
            },
          },
        },
        {
          id: "w1:p3",
          name: "verifier #7-2",
          status: "working",
          pull: 42,
          pull_closed: false,
          focusable: true,
          workflow: {
            kind: "step",
            runId: 7,
            step: "verify",
            sequence: 2,
          },
        },
        {
          id: "w2:p1",
          name: "dev #99",
          status: "working",
          pull: 99,
          pull_closed: false,
          focusable: true,
        },
      ],
      pull_workspaces: [{ pull: 42, pane_id: "w1:p1", status: "working" }],
      issue_workspaces: [],
    },
  ],
};

describe("PullHerdrSection", () => {
  it("renders nothing when no agent pane is running for the PR", () => {
    herdrSessions.value = { repos: [] };
    const { container } = render(
      <PullHerdrSection owner="me" repo="proj" pull={42} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("lists every PR pane as a Workflow parent-child tree with title and cost", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);

    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByText("orchestrator #7")).toBeTruthy();
    expect(screen.getByText("executor #7-1")).toBeTruthy();
    expect(screen.getByText("verifier #7-2")).toBeTruthy();
    expect(screen.queryByText("dev #99")).toBeNull();
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.getAllByText("n/a")).toHaveLength(2);
    expect(screen.getByText("executor #7-1").closest("li")?.dataset.depth).toBe(
      "1",
    );
    expect(screen.getByText("verifier #7-2").closest("li")?.dataset.depth).toBe(
      "1",
    );
  });

  it("opens pane, agent, session, usage, and cost details on hover", () => {
    vi.useFakeTimers();
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);

    fireEvent.mouseEnter(screen.getByText("orchestrator #7").closest("li")!);
    act(() => vi.advanceTimersByTime(300));

    const dialog = screen.getByRole("dialog", {
      name: "orchestrator #7 agent details",
    });
    expect(dialog.textContent).toContain("orchestrator #7");
    expect(dialog.textContent).toContain("workflow-parent");
    expect(dialog.textContent).toContain("codex");
    expect(dialog.textContent).toContain("parent-session");
    expect(dialog.textContent).toContain("200");
    expect(dialog.textContent).toContain("$1.25");
  });

  it("focuses the selected pane through the existing mutation", () => {
    vi.useFakeTimers();
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    fireEvent.mouseEnter(screen.getByText("executor #7-1").closest("li")!);
    act(() => vi.advanceTimersByTime(300));
    fireEvent.click(screen.getByRole("button", { name: "Open in Herdr" }));
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p2" },
      expect.anything(),
    );
  });

  it("keeps the popover open while the pointer moves to its action", () => {
    vi.useFakeTimers();
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    const row = screen.getByText("executor #7-1").closest("li")!;
    fireEvent.mouseEnter(row);
    act(() => vi.advanceTimersByTime(300));
    const dialog = screen.getByRole("dialog", {
      name: "executor #7-1 agent details",
    });

    fireEvent.mouseLeave(row, { relatedTarget: dialog });

    expect(
      screen.getByRole("dialog", { name: "executor #7-1 agent details" }),
    ).toBeTruthy();
  });

  it("disables focus for an agent without a real pane id", () => {
    herdrSessions.value = {
      ...running,
      repos: [
        {
          ...running.repos[0],
          agents: [
            {
              ...running.repos[0].agents[0],
              id: "synthetic",
              focusable: false,
            },
          ],
        },
      ],
    };
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    fireEvent.focus(screen.getByText("orchestrator #7").closest("div")!);

    expect(
      (
        screen.getByRole("button", {
          name: "Open in Herdr",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps the focus action pending and reports failure through the existing error path", () => {
    vi.useFakeTimers();
    herdrSessions.value = running;
    herdrSessions.focusPending = true;
    const { rerender } = render(
      <PullHerdrSection owner="me" repo="proj" pull={42} />,
    );
    fireEvent.mouseEnter(screen.getByText("orchestrator #7").closest("li")!);
    act(() => vi.advanceTimersByTime(300));
    expect(
      (
        screen.getByRole("button", {
          name: "Open in Herdr",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    herdrSessions.focusPending = false;
    rerender(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in Herdr" }));
    act(() =>
      focusHerdrAgent.mock.calls
        .at(-1)?.[1]
        .onError(new Error("Herdr pane no longer exists")),
    );
    expect(showError).toHaveBeenCalledWith("Herdr pane no longer exists");
  });

  it("shows a visible acquisition error instead of stale agent data", () => {
    herdrSessions.value = running;
    herdrSessions.isError = true;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Failed to load Agents",
    );
    expect(screen.queryByText("orchestrator #7")).toBeNull();
  });
});
