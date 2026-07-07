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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
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
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([repoRoute, settingsRoute]),
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

describe("IssueList", () => {
  it("renders open and closed issue tabs on the repo top route", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "issues/list": () => [] }));

    renderIssueList(<IssueList owner="me" repo="proj" />);

    expect(await screen.findByText("No open issues.")).toBeTruthy();
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
    expect(
      screen.getByRole("link", { name: /settings/i }).getAttribute("href"),
    ).toBe("/r/me/proj/settings");
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

  it("renders a dropdown label filter and adds selected labels immediately in select mode", async () => {
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
    const select = await screen.findByRole("combobox", {
      name: "Label filter",
    });

    expect(screen.queryByLabelText("Labels filter")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();

    fireEvent.change(select, { target: { value: "bug" } });

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

    const select = await screen.findByRole("combobox", {
      name: "Label filter",
    });
    expect(screen.getByLabelText("Selected labels").textContent).toContain(
      "bug",
    );

    fireEvent.change(select, { target: { value: "ui" } });

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
});
