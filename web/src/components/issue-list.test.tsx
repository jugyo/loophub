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
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import type { Issue, LinkedPull } from "@/api/types";

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
  const router = createRouter({
    routeTree: rootRoute.addChildren([repoRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...rendered, router };
}

function linkedPull(state: "open" | "closed" = "open"): LinkedPull {
  return {
    number: 10,
    title: "PR",
    state,
    merged: false,
    html_url: "/pulls/10",
    github_pull: null,
    cost_stopped: false,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  const pull = linkedPull();
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
    linked_pull_request: pull,
    linked_pull_requests: [pull],
    has_open_pull_request: true,
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
  describe.each([
    {
      surface: "the repo top workspace-filter branch",
      path: "/r/me/proj",
      showWorkspaceFilter: true,
    },
    {
      surface: "the repo top without the workspace filter",
      path: "/r/me/proj",
      showWorkspaceFilter: false,
    },
  ])("Start workflow on $surface", ({ path, showWorkspaceFilter }) => {
    it.each([
      {
        state: "no linked PR",
        linkedPulls: [] as LinkedPull[],
        hasOpenPullRequest: false,
        showsButton: true,
      },
      {
        state: "all linked PRs closed",
        linkedPulls: [linkedPull("closed")],
        hasOpenPullRequest: false,
        showsButton: true,
      },
      {
        state: "an open linked PR",
        linkedPulls: [linkedPull("open")],
        hasOpenPullRequest: true,
        showsButton: false,
      },
    ])("$state: Start workflow visible=$showsButton", async ({
      linkedPulls,
      hasOpenPullRequest,
      showsButton,
    }) => {
      vi.stubGlobal(
        "fetch",
        mockRpcFetch({
          "issues/list": () => [
            issue({
              linked_pull_request: linkedPulls[0],
              linked_pull_requests: linkedPulls,
              has_open_pull_request: hasOpenPullRequest,
            }),
          ],
          "workflows/list": () => [],
        }),
      );

      renderIssueList(
        <IssueList
          owner="me"
          repo="proj"
          showWorkspaceFilter={showWorkspaceFilter}
        />,
        path,
      );

      expect(await screen.findByText("Fix the thing")).toBeTruthy();
      const button = screen.queryByRole("button", {
        name: /Start workflow/,
      });
      expect(!!button).toBe(showsButton);
    });
  });

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
    expect(issueControls?.className).toContain("items-start");
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
      prompt: expect.stringContaining("Create an AFK-ready LoopHub issue"),
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
      expect(rpcCall("pageData/issueList")?.params).toMatchObject({
        repo: "me/proj",
        state: "all",
        labels: ["bug", "ui"],
        perPage: 21,
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
    expect(picker.textContent).toContain("bug");
    expect(screen.queryByLabelText("Selected labels")).toBeNull();

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

  it("shows the number of selected labels in the picker", async () => {
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

    renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        labelsParam="bug,ui"
        stateParam="all"
        labelFilterMode="select"
      />,
      "/r/me/proj?labels=bug,ui&state=all",
    );

    const picker = await screen.findByRole("button", {
      name: "Label filter",
    });
    expect(picker.textContent).toContain("2 selected");
    expect(screen.queryByLabelText("Selected labels")).toBeNull();
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
    const picker = screen.getByRole("button", { name: "Label filter" });
    fireEvent.pointerDown(picker);
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

  it("shows the workspace chip on issue rows only when set", async () => {
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

    expect(await screen.findByText("workspace:feature/foo-bar")).toBeTruthy();
    expect(screen.getByText("Branch issue")).toBeTruthy();
    expect(screen.getByText("Default branch issue")).toBeTruthy();
    expect(screen.queryByText("workspace:null")).toBeNull();
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
    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent ?? "");
    expect(headings).toHaveLength(3);
    expect(headings[0]).toBe("develop");
    expect(headings[1]).toContain("feature/a");
    expect(headings[2]).toBe("feature/b");

    const defaultSection = screen
      .getByRole("heading", {
        name: "develop",
      })
      .closest("section");
    expect(defaultSection?.textContent).toContain("Implicit default issue");
    expect(defaultSection?.textContent).toContain("Explicit default issue");

    // Workspace-registered branches now render inline as non-link sections
    // instead of linking to a dedicated workspace page.
    const workspaceSection = screen
      .getByRole("heading", { name: /feature\/a/ })
      .closest("section");
    expect(workspaceSection?.textContent).toContain("Feature issue");
    expect(screen.queryByText("Open workspace")).toBeNull();
  });

  it("combines the repository workspace filter with state and labels", async () => {
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
          {
            branch: "feature/archived",
            created_at: "2026-01-01T00:00:00Z",
            archived_at: "2026-01-02T00:00:00Z",
            branch_exists: true,
          },
        ],
        "issues/list": (params) =>
          [
            issue({ number: 1, title: "Default issue" }),
            issue({
              number: 2,
              title: "Selected workspace issue",
              target_branch: "feature/a",
              labels: [{ name: "ui", color: null }],
            }),
            issue({
              number: 3,
              title: "Archived workspace issue",
              target_branch: "feature/archived",
            }),
          ].filter(
            (item) =>
              !params.workspace || item.target_branch === params.workspace,
          ),
        "labels/list": () => [{ name: "bug", color: null }],
      }),
    );

    const { router } = renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        workspaceParam="feature/a"
        labelsParam="bug"
        stateParam="all"
        labelFilterMode="select"
        showWorkspaceFilter
      />,
      "/r/me/proj?workspace=feature%2Fa&labels=bug&state=all",
    );

    expect(await screen.findByText("Selected workspace issue")).toBeTruthy();
    expect(screen.queryByText("Default issue")).toBeNull();
    expect(screen.queryByText("Archived workspace issue")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Workspace filter" }).textContent,
    ).toContain("feature/a");
    expect(
      screen
        .getByRole("button", { name: /new issue/i })
        .closest('[data-debug-component="CreateIssueButton"]')?.textContent,
    ).toContain("in feature/a");
    // The state tab and row label chip both keep the active workspace filter.
    expect(
      screen.getByRole("tab", { name: "Closed" }).getAttribute("href"),
    ).toBe("/r/me/proj?labels=bug&state=closed&workspace=feature%2Fa");
    expect(
      screen.getByTitle('Filter issues by "ui"').getAttribute("href"),
    ).toBe("/r/me/proj?labels=ui&state=all&workspace=feature%2Fa");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Workspace filter" }),
    );
    expect(await screen.findByRole("menuitem", { name: "All" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "main (default)" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "feature/a" })).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "feature/archived" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "All" }));

    await waitFor(() =>
      expect(
        router.state.location.pathname + router.state.location.searchStr,
      ).toBe("/r/me/proj?labels=bug&state=all"),
    );
  });

  it("opens the New workspace dialog from inside the workspace filter", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [],
        "issues/list": () => [issue({ number: 1, title: "Default issue" })],
      }),
    );

    renderIssueList(
      <IssueList owner="me" repo="proj" showWorkspaceFilter />,
      "/r/me/proj",
    );

    await screen.findByText("Default issue");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Workspace filter" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "New workspace" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "New workspace" }),
    ).toBeTruthy();
  });

  it("keeps the New workspace dialog open when clicking into the form", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [],
        "issues/list": () => [issue({ number: 1, title: "Default issue" })],
      }),
    );

    renderIssueList(
      <IssueList owner="me" repo="proj" showWorkspaceFilter />,
      "/r/me/proj",
    );

    await screen.findByText("Default issue");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Workspace filter" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "New workspace" }),
    );
    const input = await screen.findByLabelText("Branch name");

    fireEvent.pointerDown(input);
    fireEvent.click(input);

    expect(
      await screen.findByRole("dialog", { name: "New workspace" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Branch name")).toBeTruthy();
  });

  it("shows unmerged workspaces above the issue list on the repo top", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [],
        "workspaces/listUnmerged": () => [
          {
            branch: "workspace/one",
            created_at: "2026-01-01T00:00:00Z",
            archived_at: null,
            branch_exists: true,
          },
          {
            branch: "workspace/two",
            created_at: "2026-01-02T00:00:00Z",
            archived_at: null,
            branch_exists: true,
          },
        ],
        "issues/list": () => [issue({ title: "Listed issue" })],
      }),
    );

    const { router } = renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        showWorkspaceFilter
        labelsParam="bug"
        stateParam="all"
      />,
      "/r/me/proj?labels=bug&state=all",
    );

    const firstWorkspace = await screen.findByRole("link", {
      name: "workspace/one",
    });
    expect(screen.getByRole("link", { name: "workspace/two" })).toBeTruthy();
    expect(screen.getByText("Unmerged workspaces:")).toBeTruthy();
    const auxiliary = firstWorkspace.closest(
      '[data-debug-component="UnmergedWorkspaces"]',
    );
    const issueList = screen.getByText("Listed issue").closest("ul");
    expect(
      auxiliary?.compareDocumentPosition(issueList as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(firstWorkspace);
    await waitFor(() =>
      expect(
        router.state.location.pathname + router.state.location.searchStr,
      ).toBe("/r/me/proj?labels=bug&state=all&workspace=workspace%2Fone"),
    );
  });

  it("omits the unmerged workspace auxiliary when core returns none", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [],
        "workspaces/listUnmerged": () => [],
        "issues/list": () => [issue({ title: "Listed issue" })],
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" showWorkspaceFilter />);

    expect(await screen.findByText("Listed issue")).toBeTruthy();
    expect(screen.queryByText("Unmerged workspaces:")).toBeNull();
  });

  it("treats unassigned issues as members of the default workspace", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "repos/get": () => ({ default_branch: "main" }),
        "workspaces/list": () => [],
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

    renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        workspaceParam="main"
        showWorkspaceFilter
      />,
      "/r/me/proj?workspace=main",
    );

    expect(await screen.findByText("Implicit default issue")).toBeTruthy();
    expect(screen.getByText("Explicit default issue")).toBeTruthy();
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
    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent ?? "");
    expect(headings).toHaveLength(4);
    expect(headings[0]).toBe("main");
    expect(headings[1]).toContain("workspace/empty");
    expect(headings[2]).toContain("workspace/missing");
    expect(headings[3]).toBe("workspace/archived");

    // A workspace whose branch is gone surfaces the warning and its issues
    // inline now that the dedicated workspace page is removed.
    const missingSection = screen
      .getByRole("heading", { name: /workspace\/missing/ })
      .closest("section");
    expect(missingSection?.textContent).toContain("branch missing");
    expect(missingSection?.textContent).toContain("Missing branch issue");
    expect(screen.queryByText("Open workspace")).toBeNull();
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

  it("renders a workspace matching the default branch inline without a link", async () => {
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

    expect(await screen.findByText("Implicit default issue")).toBeTruthy();
    expect(screen.getByText("Explicit default issue")).toBeTruthy();
    expect(
      screen.getByText("workspace registered as default branch"),
    ).toBeTruthy();
    expect(screen.queryByText("Open workspace")).toBeNull();
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

  it("shows at most 20 issues initially and offers load more when more exist", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => issues(21) }));

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Issue 20")).toBeTruthy();
    expect(screen.queryByText("Issue 21")).toBeNull();
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("does not show load more when the first page has exactly 20 issues", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => issues(20) }));

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("Issue 20")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("loads the next 20 issues with the existing filters", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": (params) =>
          params.page === 1 ? issues(21) : issues(20, 21),
      }),
    );

    renderIssueList(
      <IssueList owner="me" repo="proj" labelsParam="bug" stateParam="all" />,
      "/r/me/proj?labels=bug&state=all",
    );

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Issue 21")).toBeTruthy();
    expect(await screen.findByText("Issue 40")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await waitFor(() =>
      expect(rpcCalls("pageData/issueList").at(-1)?.params).toMatchObject({
        repo: "me/proj",
        state: "all",
        labels: ["bug"],
        perPage: 21,
        page: 2,
      }),
    );
  });

  it("loads workspace pages with the workspace filter applied by the server", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": (params) =>
          params.page === 1
            ? issues(21).map((item) => ({
                ...item,
                target_branch: "feature/a",
              }))
            : issues(2, 21).map((item) => ({
                ...item,
                target_branch: "feature/a",
              })),
      }),
    );

    renderIssueList(
      <IssueList
        owner="me"
        repo="proj"
        showWorkspaceFilter
        workspaceParam="feature/a"
      />,
      "/r/me/proj?workspace=feature%2Fa",
    );

    expect(await screen.findByText("Issue 20")).toBeTruthy();
    expect(screen.queryByText("Issue 21")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Issue 21")).toBeTruthy();
    expect(await screen.findByText("Issue 22")).toBeTruthy();
    expect(screen.getAllByText("Issue 21")).toHaveLength(1);
    await waitFor(() =>
      expect(rpcCalls("pageData/issueList").at(-1)?.params).toMatchObject({
        repo: "me/proj",
        workspace: "feature/a",
        lookahead: true,
        perPage: 21,
        page: 2,
      }),
    );
  });

  it("keeps load more available when the next page has a lookahead item", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "issues/list": (params) => {
          if (params.page === 1) return issues(21);
          if (params.page === 2) return issues(21, 21);
          return issues(1, 41);
        },
      }),
    );

    renderIssueList(<IssueList owner="me" repo="proj" />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Issue 40")).toBeTruthy();
    expect(screen.queryByText("Issue 41")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Issue 41")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});
