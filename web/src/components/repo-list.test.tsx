import type { UseQueryResult } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Repo } from "@/api/types";
import { RepoList } from "./repo-list";

afterEach(cleanup);

function repo(full_name: string, id: number): Repo {
  return {
    id,
    name: full_name.split("/")[1],
    full_name,
    default_branch: "main",
    local_path: `/tmp/${id}`,
    archived: false,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    merge_mode: null,
  };
}

// Minimal UseQueryResult shape for RepoList's reads.
function result(
  partial: Partial<UseQueryResult<Repo[]>>,
): UseQueryResult<Repo[]> {
  return partial as UseQueryResult<Repo[]>;
}

// RepoList renders <Link>, which needs a router context.
function renderInRouter(ui: React.ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, repoRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("RepoList", () => {
  it("shows a loading indicator while fetching", async () => {
    renderInRouter(
      <RepoList
        query={result({ isLoading: true })}
        emptyTitle=""
        emptyDescription=""
      />,
    );
    expect(await screen.findByText(/Loading repositories/i)).toBeTruthy();
  });

  it("shows an error state on failure", async () => {
    renderInRouter(
      <RepoList
        query={result({ isError: true, error: new Error("boom") })}
        emptyTitle=""
        emptyDescription=""
      />,
    );
    expect(
      await screen.findByText(/Failed to load repositories/i),
    ).toBeTruthy();
    expect(screen.getByText(/boom/)).toBeTruthy();
  });

  it("shows the empty state when there are no repos", async () => {
    renderInRouter(
      <RepoList
        query={result({ data: [] })}
        emptyTitle="No repositories yet"
        emptyDescription="Register one to get started."
      />,
    );
    expect(await screen.findByText("No repositories yet")).toBeTruthy();
    expect(screen.getByText("Register one to get started.")).toBeTruthy();
  });

  it("links each repo to /r/:owner/:repo", async () => {
    renderInRouter(
      <RepoList
        query={result({ data: [repo("me/alpha", 1), repo("me/beta", 2)] })}
        emptyTitle=""
        emptyDescription=""
      />,
    );
    const alpha = (await screen.findByText("me/alpha")).closest("a");
    const beta = screen.getByText("me/beta").closest("a");
    expect(alpha?.getAttribute("href")).toBe("/r/me/alpha");
    expect(beta?.getAttribute("href")).toBe("/r/me/beta");
  });

  it("renders repos in case-insensitive alphabetical order by full_name", async () => {
    renderInRouter(
      <RepoList
        query={result({
          data: [
            repo("zed/gamma", 1),
            repo("Acme/widget", 2),
            repo("acme/Alpha", 3),
            repo("me/beta", 4),
          ],
        })}
        emptyTitle=""
        emptyDescription=""
      />,
    );
    await screen.findByText("zed/gamma");
    const order = screen.getAllByRole("link").map((a) => a.textContent?.trim());
    expect(order).toEqual([
      "acme/Alpha",
      "Acme/widget",
      "me/beta",
      "zed/gamma",
    ]);
  });
});
