import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import type { InboxMessage } from "@/api/types";
import { WebConfigProvider } from "@/lib/web-config";
import { InboxPage } from "./inbox-page";

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: 1,
    repo: { name: "me/proj" },
    from: { kind: "agent", repo: "me/proj", actor: "impl-bot" },
    to: null,
    label: "review",
    title: "Ready for review",
    body: "PR #12 is ready.\nPlease check the evidence.",
    state: "unread",
    created_at: "2026-07-08T09:00:00Z",
    ...overrides,
  };
}

function renderPage(messages: InboxMessage[], experimental = true) {
  vi.stubGlobal("fetch", mockRpcFetch({ "inbox/list": () => messages }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <WebConfigProvider config={{ experimental, debug: false }}>
        <InboxPage />
      </WebConfigProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InboxPage", () => {
  it("lists cross-repo messages with optional target and label fields", async () => {
    renderPage([
      message(),
      message({
        id: 2,
        repo: { name: "team/api" },
        from: {
          kind: "scheduled_task",
          repo: "team/api",
          task_id: 4,
          run_id: 9,
        },
        to: { kind: "human" },
        label: null,
        title: "Nightly report",
        body: "No changes.",
        state: "read",
      }),
    ]);

    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
    expect(await screen.findByText("me/proj")).toBeTruthy();
    expect(
      screen.getByText("actor:impl-bot kind:agent repo:me/proj"),
    ).toBeTruthy();
    expect(screen.getByText("review")).toBeTruthy();
    expect(
      screen.getByText("PR #12 is ready. Please check the evidence."),
    ).toBeTruthy();
    expect(screen.getByText("team/api")).toBeTruthy();
    expect(screen.getByText("kind:human")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Scheduled task #4" })
        .getAttribute("href"),
    ).toBe("/r/team/api/scheduled-tasks");
    expect(screen.getByText("run #9")).toBeTruthy();

    await waitFor(() => {
      expect(rpcCall("inbox/list")?.params).toEqual({ limit: 100 });
    });
    expect(screen.getByText("Nightly report").className).toContain(
      "text-muted-foreground",
    );
  });

  it("hides scheduled task messages when experimental UI is disabled", async () => {
    renderPage(
      [
        message({
          from: {
            kind: "scheduled_task",
            repo: "team/api",
            task_id: 4,
            run_id: 9,
          },
        }),
      ],
      false,
    );

    expect(await screen.findByText("No active Inbox messages.")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Scheduled task #4" }),
    ).toBeNull();
    expect(screen.queryByText(/kind:scheduled_task/)).toBeNull();
  });

  it("expands a message row to show the full body", async () => {
    renderPage([message()]);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Show message body: Ready for review",
      }),
    );

    expect(
      screen.getByText((_content, element) => {
        return (
          element?.tagName === "PRE" &&
          element.textContent === "PR #12 is ready.\nPlease check the evidence."
        );
      }),
    ).toBeTruthy();
  });

  it("marks active messages read, archives, and soft-deletes them", async () => {
    const row = message();
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "inbox/list": () => [row],
        "inbox/read": (params) => ({ ...row, id: params.id, state: "read" }),
        "inbox/archive": (params) => ({
          ...row,
          id: params.id,
          state: "archived",
        }),
        "inbox/delete": (params) => ({
          ...row,
          id: params.id,
          state: "deleted",
        }),
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <InboxPage />
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Mark message read: Ready for review",
      }),
    );
    await waitFor(() => {
      expect(rpcCall("inbox/read")?.params).toMatchObject({ id: 1 });
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Archive message: Ready for review",
      }),
    );
    await waitFor(() => {
      expect(rpcCall("inbox/archive")?.params).toMatchObject({ id: 1 });
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete message: Ready for review",
      }),
    );
    await waitFor(() => {
      expect(rpcCall("inbox/delete")?.params).toMatchObject({ id: 1 });
    });
  });

  it("shows archived messages and can unarchive them", async () => {
    const active = message();
    const archived = message({
      id: 2,
      title: "Archived report",
      body: "Already handled.",
      state: "archived",
    });
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "inbox/list": (params) =>
          params.state === "archived" ? [archived] : [active],
        "inbox/unarchive": (params) => ({
          ...archived,
          id: params.id,
          state: "read",
        }),
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <InboxPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Archived" }));

    expect(await screen.findByText("Archived report")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Unarchive message: Archived report",
      }),
    );

    await waitFor(() => {
      expect(rpcCall("inbox/unarchive")?.params).toMatchObject({ id: 2 });
    });
  });
});
