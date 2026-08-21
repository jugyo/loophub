import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettings, Notification } from "@/api/types";
import { queryKeys } from "@/queries/keys";
import { useNotificationSound } from "./use-notification-sound";

const { playNotificationBell } = vi.hoisted(() => ({
  playNotificationBell: vi.fn(),
}));

vi.mock("@/lib/notification-sound", () => ({ playNotificationBell }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const LIST_KEY = [...queryKeys.notifications(), "list", { unreadOnly: true }];

const SETTINGS: GlobalSettings = {
  agents: {
    "claude-code": { model: "opus", effort: "medium" },
    codex: { model: "gpt-5.6-sol", effort: "medium" },
    grok: { model: "grok-code-fast-1", effort: "medium" },
    opencode: { model: "opencode/big-pickle", effort: "" },
  },
  codingAgent: "claude-code",
  devCostLimitUsd: 10,
  notificationSound: true,
  theme: null,
  workflowContractLanguage: "en",
};

function makeNotification(id: number): Notification {
  return {
    id,
    kind: "merge_ready",
    severity: "info",
    repo: { name: "me/proj" },
    title: `Notification ${id}`,
    body: `Body ${id}`,
    resource: {
      kind: "pull",
      number: id,
      title: null,
      href: `/r/me/proj/pulls/${id}`,
    },
    herdr_pane_id: null,
    workflow_run_id: null,
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function Harness() {
  useNotificationSound();
  return null;
}

// Query cache updates reach the hook through a batched notification, so every change is followed
// by a turn of the event loop inside act().
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderHook(
  unread: Notification[],
  settings: GlobalSettings = SETTINGS,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(["settings"], settings);
  queryClient.setQueryData(LIST_KEY, unread);
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return {
    async deliver(next: Notification[]) {
      queryClient.setQueryData(LIST_KEY, next);
      await settle();
    },
    async setSettings(next: GlobalSettings) {
      queryClient.setQueryData(["settings"], next);
      await settle();
    },
  };
}

describe("useNotificationSound", () => {
  it("stays silent for the unread notifications already waiting at page load", async () => {
    renderHook([makeNotification(4), makeNotification(3)]);
    await settle();

    expect(playNotificationBell).not.toHaveBeenCalled();
  });

  it("rings once when a notification arrives", async () => {
    const { deliver } = renderHook([makeNotification(4)]);

    await deliver([makeNotification(5), makeNotification(4)]);

    expect(playNotificationBell).toHaveBeenCalledTimes(1);
  });

  it("stays silent when notifications are read or the same list is refetched", async () => {
    const { deliver } = renderHook([makeNotification(4), makeNotification(3)]);

    await deliver([makeNotification(4), makeNotification(3)]); // refetched
    await deliver([makeNotification(4)]); // one read
    await deliver([]); // read all

    expect(playNotificationBell).not.toHaveBeenCalled();
  });

  it("rings once for a burst arriving as separate refreshes", async () => {
    const { deliver } = renderHook([makeNotification(4)]);

    await deliver([makeNotification(5), makeNotification(4)]);
    await deliver([
      makeNotification(6),
      makeNotification(5),
      makeNotification(4),
    ]);

    expect(playNotificationBell).toHaveBeenCalledTimes(1);
  });

  it("rings again for a notification arriving after the burst", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const { deliver } = renderHook([makeNotification(4)]);

    await deliver([makeNotification(5)]);
    now.mockReturnValue(1_060_000);
    await deliver([makeNotification(6)]);

    expect(playNotificationBell).toHaveBeenCalledTimes(2);
  });

  it("stays silent while the notification sound setting is off", async () => {
    const { deliver } = renderHook([makeNotification(4)], {
      ...SETTINGS,
      notificationSound: false,
    });

    await deliver([makeNotification(5)]);

    expect(playNotificationBell).not.toHaveBeenCalled();
  });

  it("rings only for notifications arriving after the setting is turned back on", async () => {
    const { deliver, setSettings } = renderHook([makeNotification(4)], {
      ...SETTINGS,
      notificationSound: false,
    });

    await deliver([makeNotification(5)]);
    await setSettings(SETTINGS);
    expect(playNotificationBell).not.toHaveBeenCalled();

    await deliver([makeNotification(6)]);

    expect(playNotificationBell).toHaveBeenCalledTimes(1);
  });
});
