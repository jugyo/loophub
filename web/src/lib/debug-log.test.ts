import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoopEvent } from "@/api/types";
import {
  clearDebugLog,
  getDebugLogSnapshot,
  recordEvents,
  recordInvalidation,
  recordRpc,
  useDebugLog,
} from "./debug-log";

// The store only records while a subscriber is attached (the debug panel's mount).
// useDebugLog(true) is that subscriber, so tests enable recording by rendering the hook.
let unsubscribe: (() => void) | null = null;

function enableRecording() {
  const rendered = renderHook(() => useDebugLog(true));
  unsubscribe = () => rendered.unmount();
}

function event(id: number, type = "issue.updated"): LoopEvent {
  return {
    id,
    type,
    actor: "me",
    repo: "me/proj",
    payload: { number: 3 },
    subjects: [{ kind: "issue", number: 3 }],
    created_at: "2026-07-04T00:00:00Z",
  };
}

beforeEach(() => {
  clearDebugLog();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  clearDebugLog();
});

describe("debug-log store", () => {
  it("does not record without a subscriber", () => {
    recordRpc({ method: "repos/list", params: {}, durationMs: 1, ok: true });
    recordEvents([event(1)]);
    expect(getDebugLogSnapshot().rpcs).toHaveLength(0);
    expect(getDebugLogSnapshot().events).toHaveLength(0);
  });

  it("records events in arrival order while subscribed", () => {
    enableRecording();
    act(() => recordEvents([event(1), event(2, "pull_request.updated")]));
    const { events } = getDebugLogSnapshot();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventId: 1, type: "issue.updated" });
    expect(events[1]).toMatchObject({
      eventId: 2,
      type: "pull_request.updated",
    });
    expect(events[0].at).toBeLessThanOrEqual(events[1].at);
  });

  it("records invalidations tied to the triggering event", () => {
    enableRecording();
    act(() =>
      recordInvalidation(event(7, "issue.commented"), [
        ["issues", "me/proj"],
        ["issue", "me/proj", 3],
      ]),
    );
    const { invalidations } = getDebugLogSnapshot();
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]).toMatchObject({
      eventId: 7,
      eventType: "issue.commented",
    });
    expect(invalidations[0].keys).toEqual([
      ["issues", "me/proj"],
      ["issue", "me/proj", 3],
    ]);
  });

  it("records RPC calls with method, params, and duration", () => {
    enableRecording();
    act(() =>
      recordRpc({
        method: "events/list",
        params: { since: 1, limit: 100 },
        durationMs: 12.5,
        ok: true,
      }),
    );
    const { rpcs } = getDebugLogSnapshot();
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({
      method: "events/list",
      params: { since: 1, limit: 100 },
      durationMs: 12.5,
      ok: true,
    });
  });

  it("caps each log at 300 entries, dropping the oldest", () => {
    enableRecording();
    for (let i = 1; i <= 305; i++) {
      act(() => recordEvents([event(i)]));
    }
    const { events } = getDebugLogSnapshot();
    expect(events).toHaveLength(300);
    expect(events[0].eventId).toBe(6);
    expect(events[299].eventId).toBe(305);
  });

  it("clearDebugLog empties every log", () => {
    enableRecording();
    act(() => {
      recordEvents([event(1)]);
      recordRpc({ method: "a/b", params: {}, durationMs: 1, ok: true });
    });
    act(() => clearDebugLog());
    const snapshot = getDebugLogSnapshot();
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.invalidations).toHaveLength(0);
    expect(snapshot.rpcs).toHaveLength(0);
  });

  it("notifies subscribers when a record is appended", () => {
    const rendered = renderHook(() => useDebugLog(true));
    // A fresh subscriber re-reads the snapshot after a record is pushed.
    act(() =>
      recordRpc({ method: "x/y", params: {}, durationMs: 1, ok: true }),
    );
    expect(rendered.result.current.rpcs).toHaveLength(1);
    expect(rendered.result.current.rpcs[0].method).toBe("x/y");
    rendered.unmount();
  });
});
