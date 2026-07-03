import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrSessions } from "@/api/types";

const { focusHerdrAgent } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
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
}));

import { PullHerdrSection } from "./pull-herdr-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  focusHerdrAgent.mockClear();
  herdrSessions.value = undefined;
  herdrSessions.isError = false;
});

const running: HerdrSessions = {
  repos: [
    {
      repo: "me/proj",
      session_name: "lh-me-proj",
      agents: [{ id: "%12", name: "dev #609", status: "working" }],
      pull_workspaces: [{ pull: 42, pane_id: "%12", status: "working" }],
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

  it("shows the Agents heading, row Bot icon, session name, agent name, and status for the PR's workspace", () => {
    herdrSessions.value = running;
    const { container } = render(
      <PullHerdrSection owner="me" repo="proj" pull={42} />,
    );
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByText("lh-me-proj")).toBeTruthy();
    expect(screen.getByText(/dev #609/)).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
  });

  it.each([
    ["blocked", "text-red-500"],
    ["working", "text-yellow-500"],
    ["done", "text-blue-500"],
    ["idle", "text-green-500"],
    ["paused", "text-muted-foreground"],
  ])("colors %s status text", (status, className) => {
    herdrSessions.value = {
      repos: [
        {
          ...running.repos[0],
          agents: [{ id: "%12", name: "dev #609", status }],
          pull_workspaces: [{ pull: 42, pane_id: "%12", status }],
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
          agents: [{ id: "%12", name: "dev #609", status }],
          pull_workspaces: [{ pull: 42, pane_id: "%12", status }],
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
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.queryByText(/dev #609/)).toBeNull();
  });

  it("focuses the agent's pane via terminal/focusAgent when Focus is clicked", () => {
    herdrSessions.value = running;
    render(<PullHerdrSection owner="me" repo="proj" pull={42} />);
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "%12" },
      expect.anything(),
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
