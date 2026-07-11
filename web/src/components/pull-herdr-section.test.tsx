import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrSessions } from "@/api/types";

const { focusHerdrAgent, sendHerdrAgentInput } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
  sendHerdrAgentInput: vi.fn(),
}));
const herdrSessions = vi.hoisted(() => ({
  value: undefined as HerdrSessions | undefined,
  isError: false,
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({
    data: herdrSessions.value,
    isError: herdrSessions.isError,
  }),
  useFocusHerdrAgent: () => ({
    mutate: focusHerdrAgent,
    isPending: false,
  }),
  useSendHerdrAgentInput: () => ({
    mutate: sendHerdrAgentInput,
    isPending: false,
  }),
}));

import { PullHerdrSection } from "./pull-herdr-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  focusHerdrAgent.mockClear();
  sendHerdrAgentInput.mockClear();
  herdrSessions.value = undefined;
  herdrSessions.isError = false;
});

const running: HerdrSessions = {
  repos: [
    {
      repo: "me/proj",
      session_name: "lh-me-proj",
      agents: [{ id: "w1:p2", name: "dev #609", status: "working" }],
      pull_workspaces: [{ pull: 42, pane_id: "w1:p2", status: "working" }],
    },
  ],
};

// #609: PR-detail sidebar section showing the herdr session running this PR's worktree,
// with a Focus button that switches herdr's focus to that agent's pane.
describe("PullHerdrSection (#609)", () => {
  it("renders nothing when no herdr session is running for the PR", () => {
    herdrSessions.value = { repos: [] };
    const { container } = render(
      <PullHerdrSection owner="me" repo="proj" pull={42} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when herdr runs other PRs but not this one", () => {
    herdrSessions.value = running;
    const { container } = render(
      <PullHerdrSection owner="me" repo="proj" pull={99} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the agent without the routine working status", () => {
    herdrSessions.value = running;
    const { container } = render(
      <PullHerdrSection owner="me" repo="proj" pull={42} />,
    );
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(container.querySelectorAll("svg")).toHaveLength(3);
    expect(screen.getByText("lh-me-proj")).toBeTruthy();
    expect(screen.getByText(/dev #609/)).toBeTruthy();
    expect(screen.queryByText("working")).toBeNull();
  });

  it.each([
    ["blocked", "text-red-500"],
    ["done", "text-blue-500"],
    ["idle", "text-green-500"],
    ["paused", "text-muted-foreground"],
  ])("colors %s status text", (status, className) => {
    herdrSessions.value = {
      repos: [
        {
          ...running.repos[0],
          agents: [{ id: "w1:p2", name: "dev #609", status }],
          pull_workspaces: [{ pull: 42, pane_id: "w1:p2", status }],
        },
      ],
    };
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    expect(screen.getByText(status).classList.contains(className)).toBe(true);
  });

  it.each([
    ["blocked", "animate-bot-bounce"],
    ["working", "animate-bot-wobble"],
  ])("adds %s animation class for Herdr icon", (status, expectedClass) => {
    herdrSessions.value = {
      repos: [
        {
          ...running.repos[0],
          agents: [{ id: "w1:p2", name: "dev #609", status }],
          pull_workspaces: [{ pull: 42, pane_id: "w1:p2", status }],
        },
      ],
    };
    const { container } = render(
      <PullHerdrSection owner="me" repo="proj" pull={42} />,
    );
    const icon = container.querySelector("svg");
    expect(icon?.classList.contains(expectedClass)).toBe(true);
  });

  it("omits the agent name when no agent matches the workspace's pane id", () => {
    herdrSessions.value = {
      repos: [
        {
          ...running.repos[0],
          agents: [],
        },
      ],
    };
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    expect(screen.getByText("lh-me-proj")).toBeTruthy();
    expect(screen.queryByText("working")).toBeNull();
    expect(screen.queryByText(/dev #609/)).toBeNull();
  });

  it("focuses the agent's pane via terminal/focusAgent when Open in Herdr is clicked", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in Herdr" }));
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p2" },
      expect.anything(),
    );
  });

  it("sends the input payload and clears the field after success", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    const input = screen.getByRole("textbox", {
      name: "Message agent for PR #42",
    }) as HTMLInputElement;
    const send = screen.getByRole("button", {
      name: "Send message to agent for PR #42",
    });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Please rerun the test" } });
    fireEvent.click(send);

    expect(sendHerdrAgentInput).toHaveBeenCalledWith(
      {
        repo: "me/proj",
        pull: 42,
        paneId: "w1:p2",
        text: "Please rerun the test",
      },
      expect.anything(),
    );
    act(() => sendHerdrAgentInput.mock.calls[0][1].onSuccess());
    expect(input.value).toBe("");
    expect(screen.getByRole("status").textContent).toContain("Sent");
  });

  it("keeps the input and shows the reason after a send failure", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    const input = screen.getByRole("textbox", {
      name: "Message agent for PR #42",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Try again" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Send message to agent for PR #42",
      }),
    );
    act(() =>
      sendHerdrAgentInput.mock.calls[0][1].onError(
        new Error("The Herdr agent is no longer running for this PR"),
      ),
    );
    expect(input.value).toBe("Try again");
    expect(screen.getByRole("alert").textContent).toContain(
      "The Herdr agent is no longer running for this PR",
    );
  });

  it("renders nothing when the sessions query errored, even with stale data", () => {
    herdrSessions.value = running;
    herdrSessions.isError = true;
    const { container } = render(
      <PullHerdrSection owner="me" repo="proj" pull={42} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
