import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WebConfigProvider } from "@/lib/web-config";
import { RepoTopbar } from "./repo-topbar";

afterEach(() => {
  cleanup();
});

function renderRepoTopbar(initialPath: string, experimental = true) {
  const rootRoute = createRootRoute({
    component: RepoTopbar,
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

  return render(
    <WebConfigProvider config={{ experimental }}>
      <RouterProvider router={router} />
    </WebConfigProvider>,
  );
}

describe("RepoTopbar", () => {
  it("renders no header outside repository routes", async () => {
    renderRepoTopbar("/");

    expect(
      screen.queryByRole("navigation", { name: "Repository navigation" }),
    ).toBeNull();
    expect(document.querySelector("header")).toBeNull();
  });

  it("does not show the repo name in the repository topbar", async () => {
    renderRepoTopbar("/r/me/proj/settings");

    const nav = await screen.findByRole("navigation", {
      name: "Repository navigation",
    });

    expect(nav).toBeTruthy();
    expect(screen.queryByRole("link", { name: "me/proj" })).toBeNull();
    expect(screen.queryByText("me/proj")).toBeNull();
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

  it("hides the scheduled task tab unless experimental UI is enabled", async () => {
    renderRepoTopbar("/r/me/proj", false);

    await screen.findByRole("navigation", { name: "Repository navigation" });
    expect(screen.queryByRole("link", { name: /Scheduled task/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Issues/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Settings/ })).toBeTruthy();
  });

  it("does not make the repository section tabs a scrolling topbar region", async () => {
    renderRepoTopbar("/r/me/proj");

    await screen.findByRole("navigation", { name: "Repository navigation" });
    const sections = screen.getByLabelText("Repository sections");

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
