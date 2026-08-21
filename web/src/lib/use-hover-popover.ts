import { useEffect, useRef, useState } from "react";

// Standard delay (ms) before a hover-triggered popover appears, so a popup does
// not flash open the instant the pointer touches its target. Keyboard focus
// opens immediately (no delay) — see DESIGN.md "Hover popovers".
export const HOVER_POPUP_DELAY_MS = 300;

// Standard delay (ms) before a hover-triggered popover disappears once the
// pointer leaves, so a slight slip off the trigger on the way to a link or
// action inside the panel does not dismiss it. Escape, blur, and an explicit
// `close()` stay immediate.
export const HOVER_POPUP_CLOSE_DELAY_MS = 1000;

// Drives a hover popover's open state with a standard hover delay: pointer
// hover opens after HOVER_POPUP_DELAY_MS, leaving during the delay cancels the
// pending open (never a flash), and keyboard focus opens immediately. Leaving an
// open popover closes it after HOVER_POPUP_CLOSE_DELAY_MS; pointer or focus
// coming back to the region during that window cancels the pending close.
//
// The handlers split by role, because a trigger and the region that contains the
// trigger plus the panel are not always the same element. The trigger gets
// `onMouseEnter` / `onFocus` / `cancelPending`; the region gets `keepOpen` /
// `onMouseLeave`. When one element plays both roles, wiring the trigger handlers
// alone is enough — entering it is also entering the region. The caller keeps
// ownership of blur containment and Escape handling, and closes without delay
// via `close()`. The pending timer is always cleared on unmount.
export function useHoverPopover(delayMs: number = HOVER_POPUP_DELAY_MS) {
  const [open, setOpen] = useState(false);
  // Opening and closing are the same pending transition, so one timer holds
  // either: scheduling one always supersedes the other.
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  function onMouseEnter() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delayMs);
  }

  // Trigger: the pointer left the trigger but stayed inside the region, so drop
  // the pending open without closing an already-open popover. When the pointer
  // leaves both, the region's `onMouseLeave` runs right after this one — leave
  // events fire innermost first — so the close is still scheduled.
  function cancelPending() {
    clearTimeout(timer.current);
  }

  // Region: the pointer or focus came back to the trigger/panel region, so drop
  // the pending close. Same one timer as `cancelPending`, but a separate name
  // because it never opens: a region that is not itself the trigger (a row whose
  // popover opens from one link only) must not turn a passing pointer into an
  // open popover.
  function keepOpen() {
    clearTimeout(timer.current);
  }

  // Region: the pointer left the trigger and the panel. Leaving during the open
  // delay only cancels that open — a popover that never appeared has nothing to
  // close, and scheduling a no-op close for every row a pointer crosses is waste.
  function onMouseLeave() {
    clearTimeout(timer.current);
    if (!open) return;
    timer.current = setTimeout(
      () => setOpen(false),
      HOVER_POPUP_CLOSE_DELAY_MS,
    );
  }

  function onFocus() {
    clearTimeout(timer.current);
    setOpen(true);
  }

  function close() {
    clearTimeout(timer.current);
    setOpen(false);
  }

  return {
    open,
    onMouseEnter,
    cancelPending,
    keepOpen,
    onMouseLeave,
    onFocus,
    close,
  } as const;
}
