import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
} from "@tanstack/react-router";
import type { Issue, IssueComment } from "@/api/types";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import { IssueDetail } from "./issue-detail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const issue: Issue = {
  number: 12,
  state: "open",
  title: "ui2: issue detail",
  body: "Render title, body, labels.",
  user: { login: "me" },
  assignee: {
    session_id: "sid-1",
    agent: "impl-bot",
    session: "run-1",
    name: "impl-bot",
  },
  labels: [{ name: "ready-to-build" }],
  comments: 1,
  created_at: "2026-06-17T11:00:00Z",
  updated_at: "2026-06-17T12:00:00Z",
  linked_pull_request: {
    number: 30,
    title: "ui2: issue detail PR",
    state: "open",
    merged: false,
  },
};

const comments: IssueComment[] = [
  {
    id: 1,
    user: { login: "design-bot" },
    body: "Looks good.",
    created_at: "2026-06-17T11:30:00Z",
  },
];

function mockFetch() {
  return mockRpcFetch({
    "issues/get": () => issue,
    "comments/list": () => comments,
    "comments/create": (p) => ({
      id: 2,
      user: { login: "me" },
      body: p.body,
      created_at: "2026-06-17T12:30:00Z",
    }),
  });
}

function renderDetail() {
  vi.stubGlobal("fetch", mockFetch());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <IssueDetail owner="me" repo="proj" number={12} />,
  });
  // The linked-PR link targets the pulls route; register it for the router.
  const pullsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, pullsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("IssueDetail", () => {
  it("renders title, body, labels, comments, and the linked PR", async () => {
    renderDetail();

    expect(await screen.findByText("ui2: issue detail")).toBeTruthy();
    expect(screen.getByText("Render title, body, labels.")).toBeTruthy();
    expect(screen.getByText("ready-to-build")).toBeTruthy();
    expect(screen.getByText("Looks good.")).toBeTruthy();

    const linked = screen.getByText("#30").closest("a");
    expect(linked?.getAttribute("href")).toBe("/r/me/proj/pulls/30");
  });

  it("posts a comment and clears the textarea on success", async () => {
    renderDetail();

    const textarea = (await screen.findByLabelText(
      "Add a comment",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Nice work" } });

    const button = screen.getByRole("button", { name: /comment/i });
    fireEvent.click(button);

    await waitFor(() => {
      const call = rpcCall("comments/create");
      expect(call).toBeTruthy();
      expect(call!.params.body).toContain("Nice work");
    });

    await waitFor(() => expect(textarea.value).toBe(""));
  });
});
