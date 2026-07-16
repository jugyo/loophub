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
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import { RepositorySearch } from "./repository-search";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSearch() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => <RepositorySearch owner="me" repo="proj" />,
  });
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([repoRoute, issueRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/r/me/proj"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function openAndSearch(query: string) {
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Search issues and pull requests",
    }),
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Search query" }), {
    target: { value: query },
  });
}

describe("RepositorySearch", () => {
  it("searches the current repository and renders issue, pull, and state details", async () => {
    let resolveSearch: (value: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "search/query": () =>
          new Promise((resolve) => {
            resolveSearch = resolve;
          }),
      }),
    );
    renderSearch();

    await openAndSearch("release");
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(rpcCall("search/query")?.params).toEqual({
      repo: "me/proj",
      query: "release",
    });

    await act(async () => {
      resolveSearch([
        {
          kind: "issue",
          number: 12,
          title: "Release checklist",
          state: "open",
        },
        {
          kind: "pull",
          number: 18,
          title: "Release branch",
          state: "closed",
        },
      ]);
    });

    const results = await screen.findByRole("list", {
      name: "Search results",
    });
    expect(within(results).getByText("Issue #12")).toBeTruthy();
    expect(within(results).getByText("Pull request #18")).toBeTruthy();
    expect(within(results).getByText("Release checklist")).toBeTruthy();
    expect(within(results).getByText("Release branch")).toBeTruthy();
    expect(within(results).getByText("open")).toBeTruthy();
    expect(within(results).getByText("closed")).toBeTruthy();
  });

  it("shows empty and failure states in the dialog", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "search/query": ({ query }) => {
          if (query === "broken") throw new RpcFault(500, "boom");
          return [];
        },
      }),
    );
    renderSearch();

    await openAndSearch("missing");
    expect(
      await screen.findByText("No matching issues or pull requests."),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search query" }), {
      target: { value: "broken" },
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Search failed.",
    );
  });

  it.each([
    {
      result: {
        kind: "issue" as const,
        number: 12,
        title: "Issue result",
        state: "open" as const,
      },
      path: "/r/me/proj/issues/12",
    },
    {
      result: {
        kind: "pull" as const,
        number: 18,
        title: "Pull result",
        state: "closed" as const,
      },
      path: "/r/me/proj/pulls/18",
    },
  ])("navigates a $result.kind result to $path", async ({ result, path }) => {
    vi.stubGlobal("fetch", mockRpcFetch({ "search/query": () => [result] }));
    const router = renderSearch();

    await openAndSearch("result");
    fireEvent.click(await screen.findByText(result.title));

    await waitFor(() => expect(router.state.location.pathname).toBe(path));
  });
});
