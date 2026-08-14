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
  getDebugLogSnapshot,
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

  it("lists received events in ascending order (newest at the bottom)", () => {
    renderPanel(true);
    openPanel();
    openTab(/Event/);
    act(() => recordEvents([event(1), event(2, "pull_request.updated")]));

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("issue.updated");
    expect(items[1].textContent).toContain("pull_request.updated");
  });

  it("renders the panel as a full-width dock in the app layout flow", () => {
    renderPanel(true);
    openPanel();
    const panel = screen.getByTestId("debug-log-panel");
    expect(panel.className).not.toContain("fixed");
    expect(panel.className).toContain("shrink-0");
    expect(panel.className).not.toContain("w-[26rem]");
    expect(panel.className).not.toContain("right-3");
  });

  it("orders tabs as RPC, Event, and Invalidation and opens on RPC", () => {
    renderPanel(true);
    openPanel();

    expect(
      screen.getAllByRole("tab").map((tab) => tab.textContent?.trim()),
    ).toEqual(["RPC", "Event", "Invalidation"]);
    expect(
      screen.getByRole("tab", { name: "RPC" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("resizes the panel height by dragging its top edge", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
    try {
      Object.defineProperty(window, "innerHeight", {
        value: 600,
        configurable: true,
      });
      renderPanel(true);
      openPanel();
      const panel = screen.getByTestId("debug-log-panel");
      const separator = screen.getByRole("separator", {
        name: "Resize debug panel",
      });
      expect(panel.style.height).toBe("320px");

      fireEvent.pointerDown(separator, { button: 0, clientY: 400 });
      fireEvent.pointerMove(document, { clientY: 200 });
      expect(panel.style.height).toBe("400px");
      expect(separator.getAttribute("aria-valuenow")).toBe("400");
      fireEvent.pointerUp(document);
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "innerHeight", descriptor);
      }
    }
  });

  it("follows the tail while pinned to the bottom and stops when scrolled up", () => {
    renderPanel(true);
    openPanel();
    openTab(/Event/);
    act(() => recordEvents([event(1)]));

    const scroll = screen.getByTestId("debug-log-scroll");
    // happy-dom does no layout, so stub the metrics of an overflowed list.
    Object.defineProperty(scroll, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(scroll, "clientHeight", {
      value: 100,
      configurable: true,
    });
    Object.defineProperty(scroll, "scrollTop", {
      value: 0,
      configurable: true,
      writable: true,
    });

    // A new entry while pinned to the bottom scrolls to the tail.
    act(() => recordEvents([event(2, "pull_request.updated")]));
    expect(scroll.scrollTop).toBe(900);

    // Scrolling up detaches from the tail; further entries keep the scroll position.
    Object.defineProperty(scroll, "scrollTop", {
      value: 400,
      configurable: true,
      writable: true,
    });
    fireEvent.scroll(scroll);
    act(() => recordEvents([event(3, "issue.commented")]));
    expect(scroll.scrollTop).toBe(400);

    // Scrolling back to the bottom re-pins and follows the tail again.
    Object.defineProperty(scroll, "scrollTop", {
      value: 900,
      configurable: true,
      writable: true,
    });
    fireEvent.scroll(scroll);
    act(() => recordEvents([event(4, "issue.updated")]));
    expect(scroll.scrollTop).toBe(900);
  });

  it("shows invalidated query keys for an event on the invalidation tab", () => {
    renderPanel(true);
    openPanel();
    act(() =>
      recordInvalidation(event(7, "issue.commented"), [
        ["issues", "me/proj"],
        ["issue", "me/proj", 3],
      ]),
    );
    openTab(/Invalidation/);
    expect(screen.getByText(/issue\.commented/)).toBeTruthy();
    expect(screen.getByText('["issues","me/proj"]')).toBeTruthy();
    expect(screen.getByText('["issue","me/proj",3]')).toBeTruthy();
  });

  it("shows RPC method, params, and duration on the RPC tab", () => {
    renderPanel(true);
    openPanel();
    act(() =>
      recordRpc({
        method: "events/list",
        params: { since: 1, limit: 100 },
        durationMs: 12.5,
        ok: true,
      }),
    );
    openTab(/RPC/);
    expect(screen.getByText("events/list")).toBeTruthy();
    expect(screen.getByText("12.5ms")).toBeTruthy();
    expect(screen.getByText('{"since":1,"limit":100}')).toBeTruthy();
  });

  it("marks failed RPC calls with their error", () => {
    renderPanel(true);
    openPanel();
    act(() =>
      recordRpc({
        method: "repos/get",
        params: { name: "me/proj" },
        durationMs: 3,
        ok: false,
        error: "Not Found",
      }),
    );
    openTab(/RPC/);
    expect(screen.getByText("repos/get")).toBeTruthy();
    expect(screen.getByText("Not Found")).toBeTruthy();
  });

  it("clears all logs via the Clear button", () => {
    renderPanel(true);
    openPanel();
    act(() =>
      recordRpc({ method: "a/b", params: {}, durationMs: 1, ok: true }),
    );
    openTab(/RPC/);
    expect(screen.getByText("a/b")).toBeTruthy();

    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "Clear debug logs" })),
    );
    expect(screen.getByText("No RPC calls yet")).toBeTruthy();
  });

  it("does not record while the panel is closed", () => {
    renderPanel(true);
    act(() => recordEvents([event(1)]));
    expect(getDebugLogSnapshot().events).toHaveLength(0);
    openPanel();
    openTab(/Event/);
    expect(screen.getByText("No events received yet")).toBeTruthy();
  });

  it("clears logs and display state when closed, then records only after reopening", () => {
    renderPanel(true);
    openPanel();
    act(() =>
      recordRpc({ method: "a/b", params: {}, durationMs: 1, ok: true }),
    );
    openTab(/RPC/);
    expect(screen.getByText("a/b")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close debug panel" }));
    expect(getDebugLogSnapshot().rpcs).toHaveLength(0);

    openPanel();
    expect(
      screen.getByRole("tab", { name: /RPC/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("No RPC calls yet")).toBeTruthy();
    openTab(/Event/);
    act(() => recordEvents([event(2, "pull_request.updated")]));
    expect(screen.getByText(/pull_request\.updated/)).toBeTruthy();
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
