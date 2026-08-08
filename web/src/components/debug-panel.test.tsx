import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoopEvent } from "@/api/types";
import {
  clearDebugLog,
  recordEvents,
  recordInvalidation,
  recordRpc,
} from "@/lib/debug-log";
import { WebConfigProvider } from "@/lib/web-config";
import { DebugPanel } from "./debug-panel";

function renderPanel(debug: boolean) {
  return render(
    <WebConfigProvider config={{ debug }}>
      <DebugPanel />
    </WebConfigProvider>,
  );
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

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Debug panel" }));
}

function openTab(label: RegExp) {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

beforeEach(() => {
  clearDebugLog();
});

afterEach(() => {
  cleanup();
  clearDebugLog();
});

describe("DebugPanel", () => {
  it("renders nothing when --debug is off", () => {
    const { container } = renderPanel(false);
    expect(container.textContent).toBe("");
  });

  it("shows a small icon that opens the panel when --debug is on", () => {
    renderPanel(true);
    const toggle = screen.getByRole("button", { name: "Debug panel" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    openPanel();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("debug-log-panel")).toBeTruthy();
  });

  it("renders the toggle as an in-flow button, not a floating overlay", () => {
    renderPanel(true);
    const toggle = screen.getByRole("button", { name: "Debug panel" });
    // The button lives in the bottom status bar, so it must not use fixed positioning.
    expect(toggle.className).not.toContain("fixed");
    expect(toggle.className).toContain("h-7");
    expect(toggle.className).toContain("ml-1");
  });

  it("keeps the toggle icon constant and only closes via the panel's close button", () => {
    renderPanel(true);
    const toggle = screen.getByRole("button", { name: "Debug panel" });
    openPanel();
    // The icon stays the same whether the panel is open or closed.
    expect(screen.getByTestId("debug-log-panel")).toBeTruthy();
    // Clicking the toggle again does not close the panel.
    fireEvent.click(toggle);
    expect(screen.getByTestId("debug-log-panel")).toBeTruthy();
    // Only the panel's close button closes it.
    fireEvent.click(screen.getByRole("button", { name: "Close debug panel" }));
    expect(screen.queryByTestId("debug-log-panel")).toBeNull();
  });

  it("lists received events in reverse-chronological order", () => {
    renderPanel(true);
    act(() => recordEvents([event(1), event(2, "pull_request.updated")]));
    openPanel();

    expect(screen.getByText("Events")).toBeTruthy();
    expect(screen.getByText(/pull_request\.updated/)).toBeTruthy();
    expect(screen.getByText(/issue\.updated/)).toBeTruthy();
  });

  it("shows invalidated query keys for an event on the invalidation tab", () => {
    renderPanel(true);
    act(() =>
      recordInvalidation(event(7, "issue.commented"), [
        ["issues", "me/proj"],
        ["issue", "me/proj", 3],
      ]),
    );
    openPanel();

    openTab(/Invalidation/);
    expect(screen.getByText(/issue\.commented/)).toBeTruthy();
    expect(screen.getByText('["issues","me/proj"]')).toBeTruthy();
    expect(screen.getByText('["issue","me/proj",3]')).toBeTruthy();
  });

  it("shows RPC method, params, and duration on the RPC tab", () => {
    renderPanel(true);
    act(() =>
      recordRpc({
        method: "events/list",
        params: { since: 1, limit: 100 },
        durationMs: 12.5,
        ok: true,
      }),
    );
    openPanel();

    openTab(/RPC/);
    expect(screen.getByText("events/list")).toBeTruthy();
    expect(screen.getByText("12.5ms")).toBeTruthy();
    expect(screen.getByText('{"since":1,"limit":100}')).toBeTruthy();
  });

  it("marks failed RPC calls with their error", () => {
    renderPanel(true);
    act(() =>
      recordRpc({
        method: "repos/get",
        params: { name: "me/proj" },
        durationMs: 3,
        ok: false,
        error: "Not Found",
      }),
    );
    openPanel();
    openTab(/RPC/);
    expect(screen.getByText("repos/get")).toBeTruthy();
    expect(screen.getByText("Not Found")).toBeTruthy();
  });

  it("clears all logs via the Clear button", () => {
    renderPanel(true);
    act(() =>
      recordRpc({ method: "a/b", params: {}, durationMs: 1, ok: true }),
    );
    openPanel();
    openTab(/RPC/);
    expect(screen.getByText("a/b")).toBeTruthy();

    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "Clear debug logs" })),
    );
    expect(screen.getByText("No RPC calls yet")).toBeTruthy();
  });

  it("keeps the panel recording while it is closed", () => {
    renderPanel(true);
    act(() => recordEvents([event(1)]));
    openPanel();
    expect(screen.getByText(/issue\.updated/)).toBeTruthy();
  });

  it("stops recording when the panel is unmounted (debug off)", () => {
    const { unmount } = renderPanel(true);
    unmount();
    act(() =>
      recordRpc({ method: "a/b", params: {}, durationMs: 1, ok: true }),
    );
    expect(document.body.textContent).not.toContain("a/b");
  });
});
