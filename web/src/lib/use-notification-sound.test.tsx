import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "#loophub-test";
import type { GlobalSettings, Notification } from "@/api/types";
import {
  clearDebugLog,
  getDebugLogSnapshot,
  useDebugLog,
} from "@/lib/debug-log";
import { queryKeys } from "@/queries/keys";
import {
  playNotificationBellOnce,
  useNotificationSound,
} from "./use-notification-sound";

const { playNotificationBell } = vi.hoisted(() => ({
  playNotificationBell: vi.fn<() => Promise<"success" | "failure">>(() =>
    Promise.resolve("success"),
  ),
}));

vi.mock("@/lib/notification-sound", () => ({ playNotificationBell }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  clearDebugLog();
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

function makeNotification(
  id: number,
  overrides: Partial<Notification> = {},
): Notification {
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
    ...overrides,
  };
}

function Harness({ pathname }: { pathname: string }) {
  useNotificationSound(pathname);
  useDebugLog(true);
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
  pathname = "/",
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
      <Harness pathname={pathname} />
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
  it("plays through the browser-wide lock when this tab acquires it", async () => {
    const request = vi.fn(async (_name, _options, callback) => callback({}));
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    await expect(playNotificationBellOnce(1)).resolves.toBe("success");
    expect(request).toHaveBeenCalledWith(
      "loophub-notification-sound",
      { ifAvailable: true },
      expect.any(Function),
    );
    expect(playNotificationBell).toHaveBeenCalledTimes(1);
  });

  it("does not play when another tab owns the browser-wide lock", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: vi.fn(async (_name, _options, callback) => callback(null)),
      },
    });

    await expect(playNotificationBellOnce(1)).resolves.toBeNull();
    expect(playNotificationBell).not.toHaveBeenCalled();
  });

  it("falls back to the existing playback when Web Locks is unavailable", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });

    await expect(playNotificationBellOnce(1)).resolves.toBe("success");
    expect(playNotificationBell).toHaveBeenCalledTimes(1);
  });

  it("does not replay a notification after the first tab releases the lock", async () => {
    const request = vi.fn(async (_name, _options, callback) => callback({}));
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    await expect(playNotificationBellOnce(7)).resolves.toBe("success");
    await expect(playNotificationBellOnce(7)).resolves.toBeNull();
    expect(playNotificationBell).toHaveBeenCalledTimes(1);
  });

  it("stays silent for the unread notifications already waiting at page load", async () => {
    renderHook([makeNotification(4), makeNotification(3)]);
    await settle();

    expect(playNotificationBell).not.toHaveBeenCalled();
  });

  it("空の unread list の後に届いた通知で鳴り、play を記録する", async () => {
    const { deliver } = renderHook([]);

    await deliver([makeNotification(1)]);

    expect(playNotificationBell).toHaveBeenCalledTimes(1);
    expect(getDebugLogSnapshot().sounds).toMatchObject([
      {
        notificationId: 1,
        decision: "play",
        reason: "new_id",
        playback: "success",
      },
    ]);
  });

  it("通知が届いたときに一度だけ鳴り、成功結果を記録する", async () => {
    const { deliver } = renderHook([makeNotification(4)]);

    await deliver([makeNotification(5), makeNotification(4)]);

    expect(playNotificationBell).toHaveBeenCalledTimes(1);
    expect(getDebugLogSnapshot().sounds).toMatchObject([
      {
        notificationId: 5,
        decision: "play",
        reason: "new_id",
        playback: "success",
      },
    ]);
  });

  it("stays silent when a new notification targets the visible page", async () => {
    const { deliver } = renderHook(
      [makeNotification(4)],
      SETTINGS,
      "/r/me/proj/pulls/4",
    );

    await deliver([
      makeNotification(5, {
        resource: {
          kind: "pull",
          number: 4,
          title: null,
          href: "/r/me/proj/pulls/4",
        },
      }),
      makeNotification(4),
    ]);

    expect(playNotificationBell).not.toHaveBeenCalled();
  });

  it("rings for an unrelated notification while a page is visible", async () => {
    const { deliver } = renderHook(
      [makeNotification(4)],
      SETTINGS,
      "/r/me/proj/pulls/4",
    );

    await deliver([
      makeNotification(5, {
        resource: {
          kind: "pull",
          number: 4,
          title: null,
          href: "/r/me/proj/pulls/4",
        },
      }),
      makeNotification(6),
      makeNotification(4),
    ]);

    expect(playNotificationBell).toHaveBeenCalledTimes(1);
  });

  it("stays silent when notifications are read or the same list is refetched", async () => {
    const { deliver } = renderHook([makeNotification(4), makeNotification(3)]);

    await deliver([makeNotification(4), makeNotification(3)]); // refetched
    await deliver([makeNotification(4)]); // one read
    await deliver([]); // read all

    expect(playNotificationBell).not.toHaveBeenCalled();
  });

  it("別々の refresh で届くバーストでは一度だけ鳴り、cooldown を記録する", async () => {
    const { deliver } = renderHook([makeNotification(4)]);

    await deliver([makeNotification(5), makeNotification(4)]);
    await deliver([
      makeNotification(6),
      makeNotification(5),
      makeNotification(4),
    ]);

    expect(playNotificationBell).toHaveBeenCalledTimes(1);
    expect(getDebugLogSnapshot().sounds).toMatchObject([
      { notificationId: 5, decision: "play", playback: "success" },
      { notificationId: 6, decision: "cooldown", playback: null },
    ]);
  });

  it("cooldown の判定時刻と経過時間を記録する", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(10_000);
    const { deliver } = renderHook([makeNotification(4)]);

    await deliver([makeNotification(5)]);
    now.mockReturnValue(11_500);
    await deliver([makeNotification(6)]);

    expect(getDebugLogSnapshot().sounds[1]).toMatchObject({
      at: 11_500,
      notificationId: 6,
      decision: "cooldown",
      cooldownElapsedMs: 1_500,
    });
  });

  it("最新の通知 ID が変わらないとき duplicate を記録する", async () => {
    const { deliver } = renderHook([makeNotification(4)]);

    await deliver([makeNotification(4), makeNotification(3)]);

    expect(getDebugLogSnapshot().sounds).toMatchObject([
      {
        notificationId: 4,
        decision: "duplicate",
        reason: "same_id",
        playback: null,
      },
    ]);
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

  it("通知音オフのとき新着通知に disabled を記録する", async () => {
    const { deliver } = renderHook([makeNotification(4)], {
      ...SETTINGS,
      notificationSound: false,
    });

    await deliver([makeNotification(5)]);

    expect(getDebugLogSnapshot().sounds).toMatchObject([
      {
        notificationId: 5,
        decision: "disabled",
        reason: "new_id",
        cooldownElapsedMs: null,
        playback: null,
      },
    ]);
  });

  it("ブラウザの再生失敗結果を記録する", async () => {
    playNotificationBell.mockResolvedValueOnce("failure");
    const { deliver } = renderHook([makeNotification(4)]);

    await deliver([makeNotification(5)]);

    expect(getDebugLogSnapshot().sounds).toMatchObject([
      { notificationId: 5, decision: "play", playback: "failure" },
    ]);
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
