import { useRouterState } from "@tanstack/react-router";
import { type RefObject, useEffect } from "react";

// The app's scroll container is the <main> element (overflow-y-auto), not the window, so
// router navigation does not reset its scroll position. Reset it to the top on every route
// change so a new screen always renders from the top. Position persistence/restore is out
// of scope (see #277).
export function useScrollToTop(ref: RefObject<HTMLElement | null>) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [pathname]);
}
