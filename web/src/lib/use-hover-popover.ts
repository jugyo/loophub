import { useEffect, useRef, useState } from "react";

// Standard delay (ms) before a hover-triggered popover appears, so a popup does
// not flash open the instant the pointer touches its target. Keyboard focus
// opens immediately (no delay) — see DESIGN.md "Hover popovers".
export const HOVER_POPUP_DELAY_MS = 300;

// Drives a hover popover's open state with a standard hover delay: pointer
// hover opens after HOVER_POPUP_DELAY_MS, leaving during the delay cancels the
// pending open (never a flash), and keyboard focus opens immediately. The
// caller keeps ownership of blur containment and Escape handling and closes via
// `close()`. The pending timer is always cleared on unmount.
export function useHoverPopover(delayMs: number = HOVER_POPUP_DELAY_MS) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  function onMouseEnter() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delayMs);
  }

  function onMouseLeave() {
    clearTimeout(timer.current);
    setOpen(false);
  }

  function onFocus() {
    clearTimeout(timer.current);
    setOpen(true);
  }

  function close() {
    clearTimeout(timer.current);
    setOpen(false);
  }

  return { open, onMouseEnter, onMouseLeave, onFocus, close } as const;
}
