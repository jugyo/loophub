import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rootRoute } from "./root";
import { workspaceRoute } from "./workspace";

vi.mock("@/components/app-layout", async () => {
  const { Outlet } = await import("@tanstack/react-router");
  return { AppLayout: () => <Outlet /> };
});
vi.mock("@/lib/use-loophub-events", () => ({ useLoopHubEvents: () => {} }));
vi.mock("@/components/workspace-page", () => ({
  WorkspacePage: ({
    workspaceName,
    labels,
    state,
  }: {
    workspaceName: string;
    labels?: string;
    state?: string;
  }) => <div>{[workspaceName, labels, state].filter(Boolean).join("|")}</div>,
}));

afterEach(cleanup);

describe("workspace route", () => {
  it("decodes a percent-containing workspace name exactly once", async () => {
    const router = createRouter({
      routeTree: rootRoute.addChildren([workspaceRoute]),
      history: createMemoryHistory({
        initialEntries: ["/r/w/release%252Fcandidate%25"],
      }),
    });

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("release%2Fcandidate%")).toBeTruthy();
  });

  it("validates and passes issue-list search params", async () => {
    const router = createRouter({
      routeTree: rootRoute.addChildren([workspaceRoute]),
      history: createMemoryHistory({
        initialEntries: ["/r/w/feature%2Falpha?labels=bug&state=closed"],
      }),
    });

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("feature/alpha|bug|closed")).toBeTruthy();
  });
});
