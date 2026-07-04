import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLoopHubEvents } from "./use-loophub-events";

type Listener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly listeners = new Map<string, Set<EventListener>>();
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data = ""): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

class MockBroadcastChannel {
  static channels = new Map<string, Set<MockBroadcastChannel>>();

  readonly listeners = new Set<Listener>();

  constructor(readonly name: string) {
    const channels =
      MockBroadcastChannel.channels.get(name) ??
      new Set<MockBroadcastChannel>();
    channels.add(this);
    MockBroadcastChannel.channels.set(name, channels);
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    for (const channel of MockBroadcastChannel.channels.get(this.name) ?? []) {
      if (channel === this) continue;
      for (const listener of channel.listeners) {
        listener({ data } as MessageEvent);
      }
    }
  }

  close(): void {
    MockBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

interface PendingLock {
  callback: () => Promise<void>;
  reject: (reason?: unknown) => void;
  resolve: () => void;
  signal?: AbortSignal;
}

class MockLockManager {
  active = false;
  pending: PendingLock[] = [];

  request(
    _name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const item = { callback, reject, resolve, signal: options.signal };
      const onAbort = () => {
        this.pending = this.pending.filter((pending) => pending !== item);
        reject(new DOMException("aborted", "AbortError"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.push(item);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const item = this.pending.shift();
    if (!item) return;
    if (item.signal?.aborted) {
      item.reject(new DOMException("aborted", "AbortError"));
      this.drain();
      return;
    }

    this.active = true;
    item.callback().then(
      () => {
        this.active = false;
        item.resolve();
        this.drain();
      },
      (error) => {
        this.active = false;
        item.reject(error);
        this.drain();
      },
    );
  }
}

function HookHarness() {
  useLoopHubEvents();
  return null;
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  MockEventSource.instances = [];
  MockBroadcastChannel.channels.clear();
  localStorage.clear();
});

describe("useLoopHubEvents", () => {
  it("uses one EventSource across seven coordinated tabs", async () => {
    const lockManager = new MockLockManager();
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: lockManager,
    });

    const clients = Array.from({ length: 7 }, () => new QueryClient());
    const invalidates = clients.map((client) =>
      vi.spyOn(client, "invalidateQueries"),
    );

    const [first, ...followers] = clients.map((client) =>
      render(<HookHarness />, { wrapper: wrapper(client) }),
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    MockEventSource.instances[0].emit("open");

    await waitFor(() => {
      for (const invalidate of invalidates) {
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["settings"] });
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: ["terminal", "config"],
        });
      }
    });

    MockEventSource.instances[0].emit(
      "loophub",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "events/notify",
        params: {
          id: 7,
          type: "issue.updated",
          actor: "me",
          repo: "me/proj",
          payload: { number: 3 },
          created_at: "2026-07-04T00:00:00Z",
        },
      }),
    );

    await waitFor(() => {
      for (const invalidate of invalidates) {
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: ["issues", "me/proj"],
        });
      }
    });
    expect(localStorage.getItem("lh_last_event_id")).toBe("7");

    first.unmount();

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(MockEventSource.instances[1].url).toBe("/events?since=7");
    for (const follower of followers) follower.unmount();
  });

  it("falls back to a direct EventSource when tab coordination is unavailable", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("BroadcastChannel", undefined);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });

    render(<HookHarness />, { wrapper: wrapper(new QueryClient()) });

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(MockEventSource.instances[0].url).toBe("/events?since=0");
  });
});
