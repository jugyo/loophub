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
import type { Issue, IssueComment } from "@/api/types";

// The Build button opens a terminal via useTerminal(); capture the call.
const { openTerminal } = vi.hoisted(() => ({ openTerminal: vi.fn() }));
vi.mock("@/components/terminal-controller", () => ({
  useTerminal: () => ({ openTerminal }),
}));

import { IssueDetail } from "./issue-detail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  openTerminal.mockClear();
});

const issue: Issue = {
  number: 12,
  state: "open",
  title: "ui2: issue detail",
  body: "Render title, body, labels.",
  user: { login: "me" },
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

function mockFetch(getIssue: () => Issue = () => issue) {
  return mockRpcFetch({
    "issues/get": getIssue,
    "comments/list": () => comments,
    "comments/create": (p) => ({
      id: 2,
      user: { login: "me" },
      body: p.body,
      created_at: "2026-06-17T12:30:00Z",
    }),
  });
}

function renderDetail(getIssue?: () => Issue) {
  vi.stubGlobal("fetch", mockFetch(getIssue));
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

  it("hides the Build button when an open PR is linked", async () => {
    // The default issue has an open linked PR (#30).
    renderDetail();

    // Close renders, so the header is mounted — Build must be absent.
    await screen.findByRole("button", { name: /close/i });
    expect(screen.queryByRole("button", { name: /build/i })).toBeNull();
  });

  it("hides the Build button when the linked PR is merged", async () => {
    const merged: Issue = {
      ...issue,
      linked_pull_request: { ...issue.linked_pull_request!, merged: true },
    };
    renderDetail(() => merged);

    await screen.findByRole("button", { name: /close/i });
    expect(screen.queryByRole("button", { name: /build/i })).toBeNull();
  });

  it("shows the Build button when no PR is linked", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    expect(await screen.findByRole("button", { name: /build/i })).toBeTruthy();
  });

  it("shows the Build button when the only linked PR is closed-unmerged", async () => {
    const rejected: Issue = {
      ...issue,
      linked_pull_request: {
        ...issue.linked_pull_request!,
        state: "closed",
        merged: false,
      },
    };
    renderDetail(() => rejected);

    expect(await screen.findByRole("button", { name: /build/i })).toBeTruthy();
  });

  it("launches `lh dev <n>` in a terminal when the Build button is clicked", async () => {
    const noPr: Issue = { ...issue, linked_pull_request: null };
    renderDetail(() => noPr);

    const button = await screen.findByRole("button", { name: /build/i });
    fireEvent.click(button);

    expect(openTerminal).toHaveBeenCalledWith({
      command: "lh dev 12",
      repo: "me/proj",
      label: "dev #12",
    });
  });
});
