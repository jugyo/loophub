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
import { IssueList } from "./issue-list";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it("renders a dropdown label filter and applies selection immediately in select mode", async () => {
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

  it("clears the dropdown label filter with the all-labels option", async () => {
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
        labelFilterMode="select"
      />,
      "/r/me/proj?labels=bug",
    );

    const select = await screen.findByRole("combobox", {
      name: "Label filter",
    });
    fireEvent.change(select, { target: { value: "" } });

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
