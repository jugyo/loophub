import { useEffect, useRef, useState } from "react";

// Shared minimum duration (ms) an action button stays in its loading state after being
// clicked, so Build/Merge don't drift to different values (#560).
export const ACTION_LOADING_MS = 1500;

// Holds a button's loading flag for a fixed minimum duration after `start()` is called,
// regardless of how fast (or slow) the triggered action actually is. For actions with no
// async completion signal of their own (e.g. Build, which just opens a terminal), this is
// the whole loading state. For actions backed by a mutation (e.g. Merge), the caller should
// combine this with the mutation's own pending flag (`isLoading || mutation.isPending`) so
// the button stays disabled until both the fixed duration has elapsed and the real request
// has completed.
export function useFixedLoading(durationMs: number = ACTION_LOADING_MS) {
  const [isLoading, setIsLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  function start() {
    setIsLoading(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIsLoading(false), durationMs);
  }

  return [isLoading, start] as const;
}
