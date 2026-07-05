import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVENT_DEBUG_LIMIT,
  recordInvalidLoopHubDebugEvent,
  recordLoopHubDebugEvent,
  recordTerminalDebugEvent,
  resetEventDebugEntriesForTest,
} from "@/lib/event-debug";
import {
  EventDebugPage,
  redactSensitive,
  redactSensitiveText,
} from "./event-debug-page";

afterEach(() => {
  cleanup();
  resetEventDebugEntriesForTest();
});

describe("EventDebugPage", () => {
  it("shows newest events first and trims the buffer to 200 entries", () => {
    for (let i = 1; i <= EVENT_DEBUG_LIMIT + 1; i++) {
      recordLoopHubDebugEvent(
        {
          id: i,
          type: "issue.updated",
          actor: "me",
          repo: "me/proj",
          payload: { number: i },
          created_at: "2026-07-04T00:00:00Z",
        },
        "{}",
      );
    }

    render(<EventDebugPage />);

    expect(screen.getByText("200 / 200")).toBeTruthy();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(EVENT_DEBUG_LIMIT);
    expect(rows[0].textContent).toContain("201");
    expect(rows.at(-1)?.textContent).toContain("2");
    expect(screen.queryByText("1")).toBeNull();
  });

  it("renders non-persistent terminal events", () => {
    recordTerminalDebugEvent();

    render(<EventDebugPage />);

    expect(screen.getByText("terminal")).toBeTruthy();
    expect(screen.getByText("none")).toBeTruthy();
    expect(screen.getByText("non-persistent")).toBeTruthy();
  });

  it("renders invalid loophub frames", () => {
    recordInvalidLoopHubDebugEvent("{ nope", "invalid JSON");

    render(<EventDebugPage />);

    expect(screen.getByText("invalid")).toBeTruthy();
    expect(screen.getByText("invalid loophub")).toBeTruthy();
    expect(screen.getByText("unreadable")).toBeTruthy();
    expect(screen.getByText(/invalid JSON/)).toBeTruthy();
  });

  it("redacts sensitive-looking payload keys and raw frames", () => {
    expect(
      redactSensitive({
        token: "abc",
        nested: {
          accessToken: "token",
          privateKeyId: "key",
          sessionId: "sid",
          safe: "visible",
        },
      }),
    ).toEqual({
      token: "[redacted]",
      nested: {
        accessToken: "[redacted]",
        privateKeyId: "[redacted]",
        sessionId: "[redacted]",
        safe: "visible",
      },
    });

    expect(
      redactSensitiveText('{"authorization":"Bearer abc","safe":"visible"}'),
    ).toBe('{"authorization":"[redacted]","safe":"visible"}');
    expect(
      redactSensitiveText('{"authorization":"Bearer abc\\\\\\"def"}'),
    ).toBe('{"authorization":"[redacted]"}');
    expect(
      redactSensitiveText("authorization: Bearer abc\nsafe: visible"),
    ).toBe("authorization: [redacted]\nsafe: visible");
  });
});
