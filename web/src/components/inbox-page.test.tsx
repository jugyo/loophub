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

function renderPage(messages: InboxMessage[]) {
  vi.stubGlobal("fetch", mockRpcFetch({ "inbox/list": () => messages }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <InboxPage />
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

    await waitFor(() => {
      expect(rpcCall("inbox/list")?.params).toEqual({ limit: 100 });
    });
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
});
