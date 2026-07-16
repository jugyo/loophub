import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { Issue } from "@/api/types";

const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));

import { IssueList } from "./issue-list";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  launchTerminal.mockClear();
});

function renderIssueList(ui: React.ReactNode, initialPath = "/r/me/proj") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => <>{ui}</>,
  });
  const repoIssuesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues",
    component: () => <>{ui}</>,
  });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/w/$workspaceName",
    component: () => <>{ui}</>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      repoRoute,
      repoIssuesRoute,
      workspaceRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...rendered, router };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    state: "open",
    title: "Fix the thing",
    body: "",
    target_branch: null,
    user: { login: "me" },
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    linked_pull_request: {
      number: 10,
      title: "PR",
      state: "open",
      merged: false,
      html_url: "/pulls/10",
      github_pull: null,
      cost_stopped: false,
    },
    linked_pull_requests: [
      {
        number: 10,
        title: "PR",
        state: "open",
        merged: false,
        html_url: "/pulls/10",
        github_pull: null,
        cost_stopped: false,
      },
    ],
    ...overrides,
  };
}

function issues(count: number, start = 1): Issue[] {
  return Array.from({ length: count }, (_value, index) => {
    const number = start + index;
    return issue({ number, title: `Issue ${number}` });
  });
}

function rpcCalls(method: string): { method: string; params: any }[] {
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
    .filter((body) => body.method === method);
}

describe("IssueList", () => {
  it("renders open and closed issue tabs on the repo top route", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => [] }));

    renderIssueList(
      <IssueList owner="me" repo="proj" labelFilterMode="select" />,
    );

    expect(await screen.findByText("No open issues.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "me/proj" })).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "Open" })
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/r/me/proj");
    expect(
      screen
        .getByRole("tab", { name: "Closed" })
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/r/me/proj?state=closed");
    expect(
      screen
        .getByRole("tab", { name: "All" })
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/r/me/proj?state=all");
    const newIssue = screen.getByRole("button", { name: /new issue/i });
    const issueControls = screen.getByRole("tablist", {
      name: "Issue state",
    }).parentElement;
    expect(issueControls?.contains(newIssue)).toBe(true);
  });

  it("launches issue creation from the issue list header", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => [] }));

    renderIssueList(<IssueList owner="me" repo="proj" />);

    fireEvent.click(await screen.findByRole("button", { name: /new issue/i }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: expect.stringMatching(/^New issue - [a-z0-9]+$/i),
      workflow: "issue-create",
    });
  });

  it("keeps the New issue button visible when issues are listed", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({ "issues/list": () => [issue({ title: "Existing" })] }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Existing")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new issue/i })).toBeTruthy();
  });

  it("uses state and labels search params for the list query", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => [] }));

    renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        labelsParam="bug,ui"
        stateParam="all"
      />,
      "/r/me/proj?labels=bug,ui&state=all",
    );

    expect(await screen.findByText("No issues.")).toBeTruthy();
    await waitFor(() =>
      expect(rpcCall("issues/list")?.params).toMatchObject({
        repo: "me/proj",
        kind: "issue",
        state: "all",
        labels: ["bug", "ui"],
        perPage: 101,
        page: 1,
      }),
    );
    expect(
      screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("preserves the all-state tab when applying label filters", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => [] }));

    const { router } = renderIssueList(
      <IssueList owner="me" repo="proj" stateParam="all" />,
      "/r/me/proj?state=all",
    );

    await screen.findByText("No issues.");
    fireEvent.change(screen.getByLabelText("Labels filter"), {
      target: { value: "bug" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(
        router.state.location.pathname + router.state.location.searchStr,
      ).toBe("/r/me/proj?labels=bug&state=all"),
    );
  });

  it("renders a shadcn label picker and adds selected labels immediately in select mode", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [],
        "labels/list": () => [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
      }),
    );

    const { router } = renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        stateParam="all"
        labelFilterMode="select"
      />,
      "/r/me/proj?state=all",
    );

    await screen.findByText("No issues.");
    const picker = await screen.findByRole("button", {
      name: "Label filter",
    });

    expect(screen.queryByLabelText("Labels filter")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();

    fireEvent.pointerDown(picker);
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "bug" }),
    );

    await waitFor(() =>
      expect(
        router.state.location.pathname + router.state.location.searchStr,
      ).toBe("/r/me/proj?labels=bug&state=all"),
    );
  });

  it("adds another label to the selected label filters", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [],
        "labels/list": () => [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
      }),
    );

    const { router } = renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        labelsParam="bug"
        stateParam="all"
        labelFilterMode="select"
      />,
      "/r/me/proj?labels=bug&state=all",
    );

    const picker = await screen.findByRole("button", {
      name: "Label filter",
    });
    expect(screen.getByLabelText("Selected labels").textContent).toContain(
      "bug",
    );

    fireEvent.pointerDown(picker);
    // The already-selected label exposes its state to assistive tech.
    expect(
      (
        await screen.findByRole("menuitemcheckbox", { name: "bug" })
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "ui" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "ui" }));

    await waitFor(() =>
      expect(
        router.state.location.pathname + router.state.location.searchStr,
      ).toBe("/r/me/proj?labels=bug%2Cui&state=all"),
    );
  });

  it("removes selected dropdown label filters individually", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [],
        "labels/list": () => [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
      }),
    );

    const { router } = renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        labelsParam="bug,ui"
        stateParam="all"
        labelFilterMode="select"
      />,
      "/r/me/proj?labels=bug,ui&state=all",
    );

    await screen.findByText("No issues.");
    expect(screen.getByLabelText("Selected labels").textContent).toContain(
      "bug",
    );
    expect(screen.getByLabelText("Selected labels").textContent).toContain(
      "ui",
    );

    fireEvent.click(screen.getByLabelText("Remove bug label filter"));

    await waitFor(() =>
      expect(
        router.state.location.pathname + router.state.location.searchStr,
      ).toBe("/r/me/proj?labels=ui&state=all"),
    );
  });

  it("clears all selected dropdown label filters", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [],
        "labels/list": () => [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
      }),
    );

    const { router } = renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        labelsParam="bug,ui"
        labelFilterMode="select"
      />,
      "/r/me/proj?labels=bug,ui",
    );

    await screen.findByText("No open issues.");
    fireEvent.click(screen.getByLabelText("Clear label filters"));

    await waitFor(() =>
      expect(
        router.state.location.pathname + router.state.location.searchStr,
      ).toBe("/r/me/proj"),
    );
  });

  it("preserves the all-state tab when clicking a row label chip", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [
          issue({ labels: [{ name: "bug", color: null }] }),
        ],
      }),
    );

    renderIssueList(
      <IssueList owner="me" repo="proj" stateParam="all" />,
      "/r/me/proj?state=all",
    );

    const chip = await screen.findByRole("link", { name: "bug" });
    expect(chip.getAttribute("href")).toBe("/r/me/proj?labels=bug&state=all");
  });

  it("keeps state and label navigation on the selected workspace route", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [
          issue({
            target_branch: "feature/alpha",
            labels: [{ name: "bug", color: null }],
          }),
        ],
        "labels/list": () => [{ name: "bug", color: null }],
      }),
    );

    const { router } = renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        labelsParam="ui"
        labelFilterMode="select"
        issueScope={{ workspace: "feature/alpha" }}
      />,
      "/r/w/feature%2Falpha?labels=ui",
    );

    const closedTab = await screen.findByRole("tab", { name: "Closed" });
    expect(closedTab.getAttribute("href")).toBe(
      "/r/w/feature%2Falpha?labels=ui&state=closed",
    );

    const rowLabel = screen.getByRole("link", { name: "bug" });
    expect(rowLabel.getAttribute("href")).toBe(
      "/r/w/feature%2Falpha?labels=bug",
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Label filter" }));
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "bug" }),
    );

    await waitFor(() =>
      expect(
        router.state.location.pathname + router.state.location.searchStr,
      ).toBe("/r/w/feature%2Falpha?labels=ui%2Cbug"),
    );
  });

  it("shows the target branch chip on issue rows only when set", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [
          issue({
            number: 1,
            title: "Branch issue",
            target_branch: "feature/foo-bar",
          }),
          issue({ number: 2, title: "Default branch issue" }),
        ],
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("branch:feature/foo-bar")).toBeTruthy();
    expect(screen.getByText("Branch issue")).toBeTruthy();
    expect(screen.getByText("Default branch issue")).toBeTruthy();
    expect(screen.queryByText("branch:null")).toBeNull();
  });

  it.each([
    "/r/me/proj",
    "/r/me/proj/issues",
  ])("shows the live PR agent input through the shared IssueList at %s", async (path) => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [issue()],
        "terminal/sessions": () => ({
          repos: [
            {
              repo: "me/proj",
              session_name: "lh-me-proj",
              agents: [{ id: "w1:p2", name: "dev #10", status: "working" }],
              pull_workspaces: [
                { pull: 10, pane_id: "w1:p2", status: "working" },
              ],
            },
          ],
        }),
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />, path);
    fireEvent.mouseEnter(await screen.findByRole("link", { name: "PR #10" }));
    expect(
      await screen.findByRole("textbox", {
        name: "Message agent for PR #10",
      }),
    ).toBeTruthy();
  });

  it("sends the linked PR agent payload and clears the input on success", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [issue()],
        "terminal/sessions": () => ({
          repos: [
            {
              repo: "me/proj",
              session_name: "lh-me-proj",
              agents: [{ id: "w1:p2", name: "dev #10", status: "working" }],
              pull_workspaces: [
                { pull: 10, pane_id: "w1:p2", status: "working" },
              ],
            },
          ],
        }),
        "terminal/sendAgentInput": () => ({ ok: true }),
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);
    fireEvent.mouseEnter(await screen.findByRole("link", { name: "PR #10" }));
    const input = (await screen.findByRole("textbox", {
      name: "Message agent for PR #10",
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Please check the logs" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Send message to agent for PR #10",
      }),
    );

    await waitFor(() =>
      expect(rpcCall("terminal/sendAgentInput")?.params).toEqual({
        repo: "me/proj",
        pull: 10,
        paneId: "w1:p2",
        text: "Please check the logs",
      }),
    );
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByRole("status").textContent).toContain("Sent");
  });

  it("blocks blank input and a second send while the first is pending", async () => {
    let resolveSend: (value: { ok: true }) => void = () => {};
    const pendingSend = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [issue()],
        "terminal/sessions": () => ({
          repos: [
            {
              repo: "me/proj",
              session_name: "lh-me-proj",
              agents: [{ id: "w1:p2", name: "dev #10", status: "working" }],
              pull_workspaces: [
                { pull: 10, pane_id: "w1:p2", status: "working" },
              ],
            },
          ],
        }),
        "terminal/sendAgentInput": () => pendingSend,
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);
    fireEvent.mouseEnter(await screen.findByRole("link", { name: "PR #10" }));
    const input = (await screen.findByRole("textbox", {
      name: "Message agent for PR #10",
    })) as HTMLInputElement;
    const send = screen.getByRole("button", {
      name: "Send message to agent for PR #10",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    expect(send.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "One request" } });
    fireEvent.click(send);
    await waitFor(() => expect(send.disabled).toBe(true));
    fireEvent.click(send);
    expect(rpcCalls("terminal/sendAgentInput")).toHaveLength(1);

    await act(async () => resolveSend({ ok: true }));
  });

  it("keeps the linked PR input and shows the reason when sending fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [issue()],
        "terminal/sessions": () => ({
          repos: [
            {
              repo: "me/proj",
              session_name: "lh-me-proj",
              agents: [{ id: "w1:p2", name: "dev #10", status: "idle" }],
              pull_workspaces: [{ pull: 10, pane_id: "w1:p2", status: "idle" }],
            },
          ],
        }),
        "terminal/sendAgentInput": () => {
          throw new RpcFault(409, "The Herdr session is no longer available");
        },
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />, "/r/me/proj/issues");
    fireEvent.mouseEnter(await screen.findByRole("link", { name: "PR #10" }));
    const input = (await screen.findByRole("textbox", {
      name: "Message agent for PR #10",
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Retry this" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Send message to agent for PR #10",
      }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The Herdr session is no longer available",
    );
    expect(input.value).toBe("Retry this");
  });

  it("does not show an agent input when the linked PR has no live Herdr pane", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": () => [issue()],
        "terminal/sessions": () => ({ repos: [] }),
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);
    fireEvent.mouseEnter(await screen.findByRole("link", { name: "PR #10" }));
    expect(
      screen.queryByRole("textbox", { name: "Message agent for PR #10" }),
    ).toBeNull();
  });

  it("groups issues by base branch with the default branch first", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "develop" }),
        "workspaces/list": () => [
          {
            branch: "feature/a",
            created_at: "2026-01-01T00:00:00Z",
            archived_at: null,
            branch_exists: true,
          },
        ],
        "issues/list": () => [
          issue({
            number: 1,
            title: "Feature issue",
            target_branch: "feature/a",
          }),
          issue({ number: 2, title: "Implicit default issue" }),
          issue({
            number: 3,
            title: "Explicit default issue",
            target_branch: "develop",
          }),
          issue({
            number: 4,
            title: "Other feature issue",
            target_branch: "feature/b",
          }),
        ],
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Implicit default issue")).toBeTruthy();
    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["develop", "feature/b"]);

    const defaultSection = screen
      .getByRole("heading", {
        name: "develop",
      })
      .closest("section");
    expect(defaultSection?.textContent).toContain("Implicit default issue");
    expect(defaultSection?.textContent).toContain("Explicit default issue");

    const workspaceLink = screen.getByRole("link", { name: /feature\/a/ });
    expect(workspaceLink.getAttribute("href")).toBe("/r/w/feature%2Fa");
    expect(screen.queryByText("Feature issue")).toBeNull();
  });

  it("shows only issues outside registered workspaces on the repository top", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [
          {
            branch: "feature/a",
            created_at: "2026-01-01T00:00:00Z",
            archived_at: null,
            branch_exists: true,
          },
        ],
        "issues/list": () => [
          issue({ number: 1, title: "Unassigned issue" }),
          issue({
            number: 2,
            title: "Workspace issue",
            target_branch: "feature/a",
          }),
          issue({
            number: 3,
            title: "Unregistered branch issue",
            target_branch: "feature/old",
          }),
        ],
      }),
    );

    renderIssueList(
      <IssueList owner="me" repo="proj" issueScope="unassigned" />,
    );

    expect(await screen.findByText("Unassigned issue")).toBeTruthy();
    expect(screen.getByText("Unregistered branch issue")).toBeTruthy();
    expect(screen.queryByText("Workspace issue")).toBeNull();
    expect(screen.queryByText("Open workspace")).toBeNull();
  });

  it("shows only issues assigned to the selected workspace", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [
          {
            branch: "feature/a",
            created_at: "2026-01-01T00:00:00Z",
            archived_at: null,
            branch_exists: true,
          },
        ],
        "issues/list": () => [
          issue({ number: 1, title: "Unassigned issue" }),
          issue({
            number: 2,
            title: "Workspace issue",
            target_branch: "feature/a",
          }),
          issue({
            number: 3,
            title: "Other workspace issue",
            target_branch: "feature/b",
          }),
        ],
      }),
    );

    renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        issueScope={{ workspace: "feature/a" }}
      />,
    );

    expect(await screen.findByText("Workspace issue")).toBeTruthy();
    expect(screen.queryByText("Unassigned issue")).toBeNull();
    expect(screen.queryByText("Other workspace issue")).toBeNull();
  });

  it("renders active workspaces in registry order, including empty and missing branches", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [
          {
            branch: "workspace/empty",
            created_at: "2026-01-01T00:00:00Z",
            archived_at: null,
            branch_exists: true,
          },
          {
            branch: "workspace/missing",
            created_at: "2026-01-02T00:00:00Z",
            archived_at: null,
            branch_exists: false,
          },
          {
            branch: "workspace/archived",
            created_at: "2026-01-03T00:00:00Z",
            archived_at: "2026-01-04T00:00:00Z",
            branch_exists: true,
          },
        ],
        "issues/list": () => [
          issue({ number: 1, title: "Default issue" }),
          issue({
            number: 2,
            title: "Missing branch issue",
            target_branch: "workspace/missing",
          }),
          issue({
            number: 3,
            title: "Archived issue",
            target_branch: "workspace/archived",
          }),
        ],
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Default issue")).toBeTruthy();
    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["main", "workspace/archived"]);
    expect(
      screen
        .getByRole("link", { name: /workspace\/empty/ })
        .getAttribute("href"),
    ).toBe("/r/w/workspace%2Fempty");
    expect(
      screen.getByRole("link", { name: /workspace\/missing/ }).textContent,
    ).toContain("branch missing");
    expect(screen.queryByText("Missing branch issue")).toBeNull();
  });

  it("keeps the existing target branch groups when the registry is empty", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [],
        "issues/list": () => [
          issue({
            title: "Targeted issue",
            target_branch: "workspace/old",
          }),
        ],
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Targeted issue")).toBeTruthy();
    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["workspace/old"]);
  });

  it("links a workspace matching the default branch to its dedicated page", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [
          {
            branch: "main",
            created_at: "2026-01-01T00:00:00Z",
            archived_at: null,
            branch_exists: true,
          },
        ],
        "issues/list": () => [
          issue({ number: 1, title: "Implicit default issue" }),
          issue({
            number: 2,
            title: "Explicit default issue",
            target_branch: "main",
          }),
        ],
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    const link = await screen.findByRole("link", { name: /main workspace/ });
    expect(link.getAttribute("href")).toBe("/r/w/main");
    expect(screen.queryByText("Implicit default issue")).toBeNull();
    expect(screen.queryByText("Explicit default issue")).toBeNull();
    expect(screen.getAllByRole("button", { name: /new issue/i })).toHaveLength(
      1,
    );
  });

  it("waits for repo metadata before rendering branch groups", async () => {
    let resolveRepo: (repo: { default_branch: string }) => void = () => {};
    const repoPromise = new Promise<{ default_branch: string }>((resolve) => {
      resolveRepo = resolve;
    });
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => repoPromise,
        "issues/list": () => [
          issue({ number: 1, title: "Implicit default issue" }),
          issue({
            number: 2,
            title: "Feature issue",
            target_branch: "feature/a",
          }),
        ],
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Implicit default issue")).toBeNull();
    expect(screen.queryByRole("heading", { name: "main" })).toBeNull();

    await act(async () => {
      resolveRepo({ default_branch: "develop" });
    });

    expect(
      await screen.findByRole("heading", { name: "develop" }),
    ).toBeTruthy();
    expect(screen.getByText("Implicit default issue")).toBeTruthy();
  });

  it("shows at most 100 issues initially and offers load more when more exist", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => issues(101) }));

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Issue 100")).toBeTruthy();
    expect(screen.queryByText("Issue 101")).toBeNull();
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("does not show load more when the first page has exactly 100 issues", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => issues(100) }));

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Issue 100")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("loads the next 100 issues with the existing filters", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": (params) =>
          params.page === 1 ? issues(101) : issues(100, 101),
      }),
    );

    renderIssueList(
      <IssueList owner="me" repo="proj" labelsParam="bug" stateParam="all" />,
      "/r/me/proj?labels=bug&state=all",
    );

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Issue 101")).toBeTruthy();
    expect(await screen.findByText("Issue 200")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await waitFor(() =>
      expect(rpcCalls("issues/list").at(-1)?.params).toMatchObject({
        repo: "me/proj",
        kind: "issue",
        state: "all",
        labels: ["bug"],
        perPage: 101,
        page: 2,
      }),
    );
  });

  it("keeps load more available when the next page has a lookahead item", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": (params) => {
          if (params.page === 1) return issues(101);
          if (params.page === 2) return issues(101, 101);
          return issues(1, 201);
        },
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Issue 200")).toBeTruthy();
    expect(screen.queryByText("Issue 201")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Issue 201")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});
