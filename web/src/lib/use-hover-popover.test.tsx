import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOVER_POPUP_CLOSE_DELAY_MS,
  HOVER_POPUP_DELAY_MS,
  useHoverPopover,
} from "./use-hover-popover";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// One element plays both roles: it is the trigger and the region that holds the
// panel (WorkflowStageBadge, AgentRow, and the row-triggered
// LinkedPullSummaryRow wire the hook this way).
function Harness() {
  const popover = useHoverPopover();
  return (
    <div
      data-testid="region"
      onMouseEnter={popover.onMouseEnter}
      onMouseLeave={popover.onMouseLeave}
      onFocus={popover.onFocus}
      onKeyDown={(event) => {
        if (event.key === "Escape") popover.close();
      }}
    >
      <span data-testid="open">{popover.open ? "yes" : "no"}</span>
    </div>
  );
}

// The other wiring: an inner link is the trigger, and the surrounding region
// holds both the link and the panel (IssueRow, and LinkedPullSummaryRow with
// popoverTrigger="pull-link"). Entering the region is not entering the trigger,
// so the region needs `keepOpen` for the close delay to be cancellable.
function NestedTriggerHarness() {
  const popover = useHoverPopover();
  return (
    <div
      data-testid="region"
      onMouseEnter={popover.keepOpen}
      onMouseLeave={popover.onMouseLeave}
      onFocus={popover.keepOpen}
      onKeyDown={(event) => {
        if (event.key === "Escape") popover.close();
      }}
    >
      <a
        href="/somewhere"
        data-testid="trigger"
        onMouseEnter={popover.onMouseEnter}
        onMouseLeave={popover.cancelPending}
        onFocus={popover.onFocus}
      >
        trigger
      </a>
      {popover.open ? (
        <div data-testid="panel">
          <a href="/inside">panel link</a>
        </div>
      ) : null}
      <span data-testid="open">{popover.open ? "yes" : "no"}</span>
    </div>
  );
}

function region() {
  return screen.getByTestId("region");
}

function isOpen() {
  return screen.getByTestId("open").textContent === "yes";
}

function openByHover() {
  fireEvent.mouseEnter(region());
  act(() => {
    vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
  });
}

describe("useHoverPopover", () => {
  it("opens on hover only after the standard delay", () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.mouseEnter(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS - 1);
    });
    expect(isOpen()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(isOpen()).toBe(true);
  });

  it("cancels the pending open when the pointer leaves during the delay", () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.mouseEnter(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS - 1);
    });
    fireEvent.mouseLeave(region());
    // Past both delays: leaving during the open delay must never flash it open.
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS + HOVER_POPUP_CLOSE_DELAY_MS);
    });
    expect(isOpen()).toBe(false);
  });

  it("opens immediately on keyboard focus", () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.focus(region());
    expect(isOpen()).toBe(true);
  });

  it("stays open until the close delay elapses after the pointer leaves", () => {
    vi.useFakeTimers();
    render(<Harness />);
    openByHover();

    fireEvent.mouseLeave(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_CLOSE_DELAY_MS - 1);
    });
    expect(isOpen()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(isOpen()).toBe(false);
  });

  it("cancels the pending close when the pointer returns during the delay", () => {
    vi.useFakeTimers();
    render(<Harness />);
    openByHover();

    fireEvent.mouseLeave(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_CLOSE_DELAY_MS - 1);
    });
    fireEvent.mouseEnter(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_CLOSE_DELAY_MS * 2);
    });
    expect(isOpen()).toBe(true);
  });

  it("cancels the pending close when focus returns during the delay", () => {
    vi.useFakeTimers();
    render(<Harness />);
    openByHover();

    fireEvent.mouseLeave(region());
    fireEvent.focus(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_CLOSE_DELAY_MS * 2);
    });
    expect(isOpen()).toBe(true);
  });

  it("closes without delay on Escape", () => {
    vi.useFakeTimers();
    render(<Harness />);
    openByHover();

    fireEvent.keyDown(region(), { key: "Escape" });
    expect(isOpen()).toBe(false);
  });

  it("clears a pending close timer on unmount", () => {
    vi.useFakeTimers();
    const view = render(<Harness />);
    openByHover();

    fireEvent.mouseLeave(region());
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// The two wirings differ only in which element carries the open handlers, and
// only the nested one can lose the pending close, so it gets its own block.
describe("useHoverPopover with the trigger nested in the region", () => {
  function trigger() {
    return screen.getByTestId("trigger");
  }

  function openByHoveringTrigger() {
    fireEvent.mouseEnter(trigger());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS);
    });
  }

  it("opens from the trigger, not from the rest of the region", () => {
    vi.useFakeTimers();
    render(<NestedTriggerHarness />);

    fireEvent.mouseEnter(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_DELAY_MS * 2);
    });
    expect(isOpen()).toBe(false);

    openByHoveringTrigger();
    expect(isOpen()).toBe(true);
  });

  it("cancels the pending close when the pointer returns to the panel", () => {
    vi.useFakeTimers();
    render(<NestedTriggerHarness />);
    openByHoveringTrigger();

    fireEvent.mouseLeave(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_CLOSE_DELAY_MS - 1);
    });
    // Back inside the region but onto the panel, not the trigger.
    fireEvent.mouseEnter(screen.getByTestId("panel"));
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_CLOSE_DELAY_MS * 2);
    });
    expect(isOpen()).toBe(true);
  });

  it("cancels the pending close when focus moves into the panel", () => {
    vi.useFakeTimers();
    render(<NestedTriggerHarness />);
    openByHoveringTrigger();

    fireEvent.mouseLeave(region());
    fireEvent.focus(screen.getByRole("link", { name: "panel link" }));
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_CLOSE_DELAY_MS * 2);
    });
    expect(isOpen()).toBe(true);
  });

  it("still closes after the delay once the pointer leaves the panel again", () => {
    vi.useFakeTimers();
    render(<NestedTriggerHarness />);
    openByHoveringTrigger();

    fireEvent.mouseLeave(region());
    fireEvent.mouseEnter(screen.getByTestId("panel"));
    fireEvent.mouseLeave(region());
    act(() => {
      vi.advanceTimersByTime(HOVER_POPUP_CLOSE_DELAY_MS);
    });
    expect(isOpen()).toBe(false);
  });

  it("leaves no pending close when the pointer only crosses the region", () => {
    vi.useFakeTimers();
    render(<NestedTriggerHarness />);

    fireEvent.mouseEnter(region());
    fireEvent.mouseLeave(region());
    expect(vi.getTimerCount()).toBe(0);
  });
});
