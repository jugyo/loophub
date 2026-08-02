import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrSessions } from "@/api/types";
import { AgentsPage, buildAgentsTrees, buildSessionTree } from "./agents-page";

const { focusHerdrAgent, showError } = vi.hoisted(() => ({
  focusHerdrAgent: vi.fn(),
  showError: vi.fn(),
}));

const herdrSessions = vi.hoisted(() => ({
  value: undefined as HerdrSessions | undefined,
  isLoading: false,
  isError: false,
  focusPending: false,
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError }),
}));

vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({
    data: herdrSessions.value,
    isLoading: herdrSessions.isLoading,
    isError: herdrSessions.isError,
  }),
  useFocusHerdrAgent: () => ({
    mutate: focusHerdrAgent,
    isPending: herdrSessions.focusPending,
  }),
}));

afterEach(() => {
  cleanup();
  focusHerdrAgent.mockClear();
  showError.mockClear();
  herdrSessions.value = undefined;
  herdrSessions.isLoading = false;
  herdrSessions.isError = false;
  herdrSessions.focusPending = false;
});

const sample: HerdrSessions = {
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
        },
        {
          id: "w2:p1",
          name: "dev #99",
          status: "working",
          pull: 99,
          pull_closed: false,
          focusable: true,
        },
        {
          id: "w3:p1",
          name: "misc agent",
          status: "idle",
          pull: null,
          pull_closed: false,
          focusable: false,
        },
      ],
      pull_workspaces: [
        { pull: 42, pane_id: "w1:p1", status: "working" },
        { pull: 99, pane_id: "w2:p1", status: "working" },
      ],
      issue_workspaces: [],
    },
  ],
};

function renderAgentsPage() {
  const rootRoute = createRootRoute({ component: Outlet });
  const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
    component: AgentsPage,
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([agentsRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/agents"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("buildSessionTree / buildAgentsTrees", () => {
  it("groups agents by PR and collects non-PR agents under other", () => {
    const tree = buildSessionTree(sample.repos[0]);
    expect(tree).not.toBeNull();
    expect(tree?.sessionName).toBe("lh-me-proj");
    expect(tree?.owner).toBe("me");
    expect(tree?.name).toBe("proj");
    expect(tree?.pullWorkspaces.map((w) => w.pull)).toEqual([42, 99]);
    expect(tree?.pullWorkspaces[0].agents.map((a) => a.id)).toEqual([
      "w1:p1",
      "w1:p2",
    ]);
    expect(tree?.otherAgents.map((a) => a.id)).toEqual(["w3:p1"]);
  });

  it("returns empty trees when sessions are missing", () => {
    expect(buildAgentsTrees(undefined)).toEqual([]);
    expect(buildAgentsTrees({ repos: [] })).toEqual([]);
  });

  it("carries stale_since onto the tree so a carried-over group can be marked", () => {
    expect(buildSessionTree(sample.repos[0])?.staleSince).toBeUndefined();
    expect(
      buildSessionTree({
        ...sample.repos[0],
        stale_since: "2026-07-31T00:00:00.000Z",
      })?.staleSince,
    ).toBe("2026-07-31T00:00:00.000Z");
  });
});

describe("AgentsPage", () => {
  it("shows loading and empty states", async () => {
    herdrSessions.isLoading = true;
    renderAgentsPage();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Loading herdr sessions/,
    );

    cleanup();
    herdrSessions.isLoading = false;
    herdrSessions.value = { repos: [] };
    renderAgentsPage();
    expect((await screen.findByRole("status")).textContent).toMatch(
      /No herdr sessions with agents/,
    );
  });

  it("shows an error when the sessions fetch fails with no data", async () => {
    herdrSessions.isError = true;
    renderAgentsPage();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Failed to load Agents/,
    );
  });

  it("renders session → PR workspace → agent hierarchy with worktree info", async () => {
    herdrSessions.value = sample;
    renderAgentsPage();

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Herdr session lh-me-proj" }),
    ).toBeTruthy();
    expect(screen.getByText("lh-me-proj")).toBeTruthy();
    expect(screen.getByText("me/proj")).toBeTruthy();

    const pr42 = screen.getByRole("link", { name: "PR #42" });
    expect(pr42.getAttribute("href")).toBe("/r/me/proj/pulls/42");
    expect(screen.getByText("worktree pr-42")).toBeTruthy();
    expect(screen.getByText("worktree pr-99")).toBeTruthy();
    expect(screen.getByText("Other workspaces")).toBeTruthy();

    expect(screen.getByText("orchestrator #7")).toBeTruthy();
    expect(screen.getByText("executor #7-1")).toBeTruthy();
    expect(screen.getByText("dev #99")).toBeTruthy();
    expect(screen.getByText("misc agent")).toBeTruthy();

    // working agents get the bot icon; every agent row has one.
    expect(document.querySelectorAll("[data-agent-bot-icon]").length).toBe(4);
  });

  it("names repos whose agent list could not be read and marks their stale sections", async () => {
    herdrSessions.value = {
      repos: [{ ...sample.repos[0], stale_since: "2026-07-31T00:00:00.000Z" }],
      capture_failed_repos: ["me/proj", "me/other"],
      captured_at: new Date().toISOString(),
    };
    renderAgentsPage();

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Could not read the agent list for me\/proj, me\/other/,
    );
    const section = screen.getByRole("region", {
      name: "Herdr session lh-me-proj",
    });
    expect(
      within(section).getByText(/Last known agents, captured/),
    ).toBeTruthy();
  });

  it("shows no capture warning when every repo was captured", async () => {
    herdrSessions.value = { ...sample, captured_at: new Date().toISOString() };
    renderAgentsPage();

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Last known agents/)).toBeNull();
  });

  it("opens focusable agents in Herdr and disables non-focusable ones", async () => {
    herdrSessions.value = sample;
    renderAgentsPage();

    const openButtons = await screen.findAllByRole("button", {
      name: "Open in Herdr",
    });
    expect(openButtons.length).toBe(4);

    const miscRow = screen.getByText("misc agent").closest("li");
    expect(miscRow).toBeTruthy();
    const miscButton = within(miscRow as HTMLElement).getByRole("button", {
      name: "Open in Herdr",
    });
    expect((miscButton as HTMLButtonElement).disabled).toBe(true);

    const orchRow = screen.getByText("orchestrator #7").closest("li");
    const orchButton = within(orchRow as HTMLElement).getByRole("button", {
      name: "Open in Herdr",
    });
    fireEvent.click(orchButton);
    expect(focusHerdrAgent).toHaveBeenCalledWith(
      { repo: "me/proj", paneId: "w1:p1" },
      expect.any(Object),
    );
  });
});
