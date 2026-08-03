import { type MouseEvent as ReactMouseEvent, useRef } from "react";

type BackdropMouseEvent = ReactMouseEvent<HTMLElement>;

export function useBackdropDismiss(onDismiss: () => void) {
  const mouseDownStartedOnBackdrop = useRef<boolean | null>(null);
  const mouseUpEndedOnBackdrop = useRef<boolean | null>(null);

  return {
    onMouseDownCapture(event: BackdropMouseEvent) {
      mouseDownStartedOnBackdrop.current = event.target === event.currentTarget;
      mouseUpEndedOnBackdrop.current = null;
    },
    onMouseUpCapture(event: BackdropMouseEvent) {
      mouseUpEndedOnBackdrop.current = event.target === event.currentTarget;
    },
    onClick(event: BackdropMouseEvent) {
      const hasMouseSequence =
        mouseDownStartedOnBackdrop.current !== null ||
        mouseUpEndedOnBackdrop.current !== null;
      const shouldDismiss =
        event.target === event.currentTarget &&
        (!hasMouseSequence ||
          (mouseDownStartedOnBackdrop.current === true &&
            mouseUpEndedOnBackdrop.current === true));
      mouseDownStartedOnBackdrop.current = null;
      mouseUpEndedOnBackdrop.current = null;
      if (shouldDismiss) onDismiss();
    },
  };
}
