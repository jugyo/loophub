import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "@/api/types";
import { queryKeys } from "./keys";
import { useReadAllNotifications, useReadNotification } from "./notifications";

const api = vi.hoisted(() => ({
  readAllNotifications: vi.fn(),
  readNotification: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  readAllNotifications: api.readAllNotifications,
  readNotification: api.readNotification,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeNotification(id: number): Notification {
  return {
    id,
    kind: "implementation_done",
    repo: { name: "me/proj" },
    title: `Notification ${id}`,
    body: "Ready for review.",
    resource: { kind: "pull", number: id, title: null, href: `/pulls/${id}` },
    herdr_pane_id: null,
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function setup() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const listKey = [...queryKeys.notifications(), "list", { limit: 30 }];
  const countKey = [...queryKeys.notifications(), "unread-count"];
  const initial = [makeNotification(2), makeNotification(1)];
  qc.setQueryData(listKey, initial);
  qc.setQueryData(countKey, { count: 2 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, listKey, countKey, initial, wrapper };
}

describe("useReadNotification", () => {
  it("optimistically removes one item and decrements the unread count", async () => {
    const { qc, listKey, countKey, wrapper } = setup();
    let resolveRead: ((notification: Notification) => void) | undefined;
    api.readNotification.mockReturnValueOnce(
      new Promise<Notification>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const { result } = renderHook(() => useReadNotification(), { wrapper });

    act(() => result.current.mutate(1));

    await waitFor(() => {
      expect(
        qc.getQueryData<Notification[]>(listKey)?.map(({ id }) => id),
      ).toEqual([2]);
      expect(qc.getQueryData(countKey)).toEqual({ count: 1 });
    });

    act(() => resolveRead?.(makeNotification(1)));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("restores the list and count when marking read fails", async () => {
    const { qc, listKey, countKey, initial, wrapper } = setup();
    api.readNotification.mockRejectedValueOnce(new Error("Read failed"));
    const { result } = renderHook(() => useReadNotification(), { wrapper });

    act(() => result.current.mutate(1));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData(listKey)).toEqual(initial);
    expect(qc.getQueryData(countKey)).toEqual({ count: 2 });
  });

  it("rolls back only the failed item when reads overlap", async () => {
    const { qc, listKey, countKey, wrapper } = setup();
    let rejectFirst: ((error: Error) => void) | undefined;
    let resolveSecond: ((notification: Notification) => void) | undefined;
    const first = new Promise<Notification>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const second = new Promise<Notification>((resolve) => {
      resolveSecond = resolve;
    });
    api.readNotification.mockImplementation((id: number) =>
      id === 1 ? first : second,
    );
    const { result } = renderHook(() => useReadNotification(), { wrapper });

    act(() => result.current.mutate(1));
    await waitFor(() =>
      expect(qc.getQueryData(countKey)).toEqual({ count: 1 }),
    );
    act(() => result.current.mutate(2));
    await waitFor(() => {
      expect(qc.getQueryData<Notification[]>(listKey)).toEqual([]);
      expect(qc.getQueryData(countKey)).toEqual({ count: 0 });
    });

    act(() => rejectFirst?.(new Error("Read failed")));
    await waitFor(() => {
      expect(
        qc.getQueryData<Notification[]>(listKey)?.map(({ id }) => id),
      ).toEqual([1]);
      expect(qc.getQueryData(countKey)).toEqual({ count: 1 });
    });
    act(() => resolveSecond?.(makeNotification(2)));
  });
});

describe("useReadAllNotifications", () => {
  it("clears the list and unread count before the request completes", async () => {
    const { qc, listKey, countKey, wrapper } = setup();
    let resolveReadAll: ((result: { count: number }) => void) | undefined;
    api.readAllNotifications.mockReturnValueOnce(
      new Promise<{ count: number }>((resolve) => {
        resolveReadAll = resolve;
      }),
    );
    const { result } = renderHook(() => useReadAllNotifications(), { wrapper });

    act(() => result.current.mutate());

    await waitFor(() => {
      expect(qc.getQueryData<Notification[]>(listKey)).toEqual([]);
      expect(qc.getQueryData(countKey)).toEqual({ count: 0 });
    });
    expect(result.current.isPending).toBe(true);

    act(() => resolveReadAll?.({ count: 2 }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("invalidates notification queries after the request succeeds", async () => {
    const { qc, wrapper } = setup();
    const invalidateQueries = vi.spyOn(qc, "invalidateQueries");
    api.readAllNotifications.mockResolvedValueOnce({ count: 2 });
    const { result } = renderHook(() => useReadAllNotifications(), { wrapper });

    act(() => result.current.mutate());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.notifications(),
    });
  });

  it("restores the list and unread count when the request fails", async () => {
    const { qc, listKey, countKey, initial, wrapper } = setup();
    api.readAllNotifications.mockRejectedValueOnce(new Error("Clear failed"));
    const { result } = renderHook(() => useReadAllNotifications(), { wrapper });

    act(() => result.current.mutate());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData(listKey)).toEqual(initial);
    expect(qc.getQueryData(countKey)).toEqual({ count: 2 });
  });
});
