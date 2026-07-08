import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RepoTopbar } from "./repo-topbar";

afterEach(() => {
  cleanup();
});

function renderRepoTopbar(initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => <RepoTopbar fallback={<div>Breadcrumb fallback</div>} />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const repoIssuesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues",
    component: () => null,
  });
  const issueDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const repoScheduledTasksRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/scheduled-tasks",
    component: () => null,
  });
  const repoSettingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings",
    component: () => null,
  });
  const mergedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/merged",
    component: () => null,
  });
  const pullDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      repoRoute,
      repoIssuesRoute,
      issueDetailRoute,
      repoScheduledTasksRoute,
      repoSettingsRoute,
      mergedRoute,
      pullDetailRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("RepoTopbar", () => {
  it("falls back to breadcrumbs outside repository routes", async () => {
    renderRepoTopbar("/");

    expect(await screen.findByText("Breadcrumb fallback")).toBeTruthy();
    expect(
      screen.queryByRole("navigation", { name: "Repository navigation" }),
    ).toBeNull();
  });

  it("shows the repo header as a link to the repo top", async () => {
    renderRepoTopbar("/r/me/proj/settings");

    const nav = await screen.findByRole("navigation", {
      name: "Repository navigation",
    });
    const repoLink = screen.getByRole("link", { name: "me/proj" });

    expect(nav).toBeTruthy();
    expect(repoLink.getAttribute("href")).toBe("/r/me/proj");
  });

  it("renders repository section tabs with links", async () => {
    renderRepoTopbar("/r/me/proj");

    await screen.findByRole("navigation", { name: "Repository navigation" });
    expect(
      screen.getByRole("link", { name: /Issues/ }).getAttribute("href"),
    ).toBe("/r/me/proj");
    expect(
      screen.getByRole("link", { name: /Scheduled task/ }).getAttribute("href"),
    ).toBe("/r/me/proj/scheduled-tasks");
    expect(
      screen.getByRole("link", { name: /Settings/ }).getAttribute("href"),
    ).toBe("/r/me/proj/settings");
  });

  it("does not make the repository section tabs a scrolling topbar region", async () => {
    renderRepoTopbar("/r/me/proj");

    await screen.findByRole("navigation", { name: "Repository navigation" });
    const sections = screen.getByLabelText("me/proj sections");

    expect(sections.className).toContain("overflow-hidden");
    expect(sections.className).not.toContain("overflow-x-auto");
  });

  it("marks the current repository section active", async () => {
    renderRepoTopbar("/r/me/proj/scheduled-tasks");

    const active = await screen.findByRole("link", {
      name: /Scheduled task/,
      current: "page",
    });

    expect(active.getAttribute("href")).toBe("/r/me/proj/scheduled-tasks");
    expect(
      screen.getByRole("link", { name: /Issues/ }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("treats repo top and issue details as the Issues section", async () => {
    renderRepoTopbar("/r/me/proj/issues/12");

    const active = await screen.findByRole("link", {
      name: /Issues/,
      current: "page",
    });

    expect(active.getAttribute("href")).toBe("/r/me/proj");
  });

  it("treats other repository subsections as the Issues section", async () => {
    renderRepoTopbar("/r/me/proj/pulls/7");

    const active = await screen.findByRole("link", {
      name: /Issues/,
      current: "page",
    });

    expect(active.getAttribute("href")).toBe("/r/me/proj");
  });

  it("treats merged pull requests as the Issues section", async () => {
    renderRepoTopbar("/r/me/proj/merged");

    const active = await screen.findByRole("link", {
      name: /Issues/,
      current: "page",
    });

    expect(active.getAttribute("href")).toBe("/r/me/proj");
  });
});
