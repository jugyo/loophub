import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
    // Two agent rows with unknown cost; the Total footer counts them as 0 and shows $1.25.
    expect(screen.getAllByText("$1.25")).toHaveLength(2);
    expect(screen.getAllByText("n/a")).toHaveLength(2);
    expect(screen.getByText("executor #7-1").closest("li")?.dataset.depth).toBe(
      "1",
    );
    expect(screen.getByText("verifier #7-2").closest("li")?.dataset.depth).toBe(
      "1",
    );
  });

  it("places cost left of Open in Herdr and shows a Total footer", () => {
    herdrSessions.value = {
      ...running,
      repos: [
        {
          ...running.repos[0],
          agents: [
            running.repos[0].agents[0],
            {
              ...running.repos[0].agents[1],
              session: {
                id: "execute-session",
                agent: "workflow-step",
                runtime: "codex",
                kind: "workflow-step",
                usage: {
                  sessions_with_usage: 1,
                  input_tokens: 10,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  output_tokens: 5,
                  total_tokens: 15,
                  cost_usd: 0.75,
                  has_unknown_cost: false,
                  context_usage_percent: null,
                },
              },
            },
          ],
        },
      ],
    };
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);

    const row = screen.getByText("orchestrator #7").closest("li")!;
    const cost = within(row).getByText("$1.25");
    const open = within(row).getByRole("button", { name: "Open in Herdr" });
    expect(
      cost.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const total = screen.getByRole("listitem", { name: "Total cost" });
    expect(within(total).getByText("Total")).toBeTruthy();
    expect(within(total).getByText("$2.00")).toBeTruthy();
  });

  it("totals the known costs when some rows have no cost", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);

    const total = screen.getByRole("listitem", { name: "Total cost" });
    expect(within(total).getByText("$1.25")).toBeTruthy();
  });

  it("shows n/a as the total when no row has a cost", () => {
    herdrSessions.value = {
      ...running,
      repos: [
        {
          ...running.repos[0],
          agents: [
            {
              ...running.repos[0].agents[0],
              session: {
                ...running.repos[0].agents[0].session!,
                usage: {
                  ...running.repos[0].agents[0].session!.usage!,
                  cost_usd: null,
                },
              },
            },
            running.repos[0].agents[1],
            running.repos[0].agents[2],
          ],
        },
      ],
    };
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);

    const total = screen.getByRole("listitem", { name: "Total cost" });
    expect(within(total).getByText("n/a")).toBeTruthy();
  });

  it("matches the linked PR bot effects for working, blocked, and inactive agents", () => {
    herdrSessions.value = {
      ...running,
      repos: [
        {
          ...running.repos[0],
          agents: [
            running.repos[0].agents[0],
            {
              ...running.repos[0].agents[1],
              status: "blocked",
            },
            {
              ...running.repos[0].agents[2],
              status: "done",
            },
          ],
        },
      ],
    };
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);

    const workingIcon = screen
      .getByText("orchestrator #7")
      .parentElement?.querySelector("[data-agent-bot-icon]");
    expect(workingIcon?.className).toContain(
      "animate-[linked-pull-pulse_2.4s_ease-out_infinite]",
    );
    expect(workingIcon?.className).toContain("bg-indigo-100");
    expect(workingIcon?.className).toContain("dark:bg-sky-950");

    const blockedIcon = screen
      .getByText("executor #7-1")
      .parentElement?.querySelector("[data-agent-bot-icon]");
    expect(blockedIcon?.className).not.toContain("opacity-45");
    expect(
      blockedIcon?.querySelector("[data-agent-bot-attention]"),
    ).toBeTruthy();

    const inactiveIcon = screen
      .getByText("verifier #7-2")
      .parentElement?.querySelector("[data-agent-bot-icon]");
    expect(inactiveIcon?.className).toContain("opacity-45");
    expect(inactiveIcon?.className).not.toContain(
      "animate-[linked-pull-pulse_2.4s_ease-out_infinite]",
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

  it("opens each pane in Herdr through the pane-title terminal icon", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    const row = screen.getByText("executor #7-1").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Open in Herdr" }));
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p2" },
      expect.anything(),
    );
  });

  it("keeps the focus action out of the hover detail popover", () => {
    vi.useFakeTimers();
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    fireEvent.mouseEnter(screen.getByText("orchestrator #7").closest("li")!);
    act(() => vi.advanceTimersByTime(300));
    const dialog = screen.getByRole("dialog", {
      name: "orchestrator #7 agent details",
    });
    expect(
      within(dialog).queryByRole("button", { name: "Open in Herdr" }),
    ).toBeNull();
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

  it("disables the terminal icon for an agent without a real pane id", () => {
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

    const button = screen.getByRole("button", {
      name: "Open in Herdr",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("This agent has no focusable Herdr pane");
  });

  it("gives the terminal icon a dark gray background so it reads as a control", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);

    const button = screen.getAllByRole("button", {
      name: "Open in Herdr",
    })[0] as HTMLButtonElement;
    expect(button.className).toContain("bg-zinc-500");
    expect(button.className).toContain("dark:bg-zinc-900");
    expect(button.className).toContain("text-zinc-50");
  });

  it("keeps the Open in Herdr control compact (size-5 frame, size-2.5 icon)", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);

    const button = screen.getAllByRole("button", {
      name: "Open in Herdr",
    })[0] as HTMLButtonElement;
    expect(button.className).toContain("size-5");
    expect(button.className).not.toContain("size-7");
    expect(button.className).not.toContain("size-6");
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").toContain("size-2.5");
  });

  it("keeps the terminal icon pending and reports failure through the existing error path", () => {
    herdrSessions.value = running;
    herdrSessions.focusPending = true;
    const { rerender } = render(
      <PullHerdrSection owner="me" repo="proj" pull={42} />,
    );
    for (const button of screen.getAllByRole("button", {
      name: "Open in Herdr",
    })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    herdrSessions.focusPending = false;
    rerender(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    const row = screen.getByText("orchestrator #7").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Open in Herdr" }));
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
