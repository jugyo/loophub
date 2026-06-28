// In-page error banner for transient operation failures (#323). A failed mutation (PR merge /
// mark-ready / close-reopen, etc.) reports its message here via useErrorBanner().showError instead
// of rendering an inline `isError` string whose lifetime is bound to the component / React Query
// observer that issued it. The banner lives at the app-shell level with an explicit lifetime:
//
//   - it auto-dismisses after a constant timeout (AUTO_DISMISS_MS),
//   - it has a close (×) button for immediate manual dismissal, and
//   - it is cleared on route change, so feedback never outlives the operation's context.
//
// This makes "feedback disappears once you leave the operation's context" structural — it does not
// depend on keying a component to a fresh mutation observer the way the inline errors did, which is
// how a stale "Merge failed" could leak onto the next PR (#321). The context defaults to a no-op so
// consumers render fine without a provider (e.g. unit tests), mirroring detail-title.tsx /
// terminal-controller.tsx.

import { useRouterState } from "@tanstack/react-router";
import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// How long a banner stays before it auto-dismisses. Implementation discretion (#323): long enough
// to read a failure message, short enough that it never lingers into an unrelated context.
const AUTO_DISMISS_MS = 8000;

interface ErrorBannerContextValue {
  /** The current banner message, or null when nothing is shown. */
  message: string | null;
  /** Show an error banner with `message`, restarting the auto-dismiss timer. */
  showError: (message: string) => void;
  /** Dismiss the current banner immediately (close button / route change). */
  dismiss: () => void;
}

const noop = () => {};

const ErrorBannerContext = createContext<ErrorBannerContextValue>({
  message: null,
  showError: noop,
  dismiss: noop,
});

export function ErrorBannerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setMessage(null);
  }, [clearTimer]);

  const showError = useCallback(
    (msg: string) => {
      clearTimer();
      setMessage(msg);
      timer.current = setTimeout(() => {
        timer.current = null;
        setMessage(null);
      }, AUTO_DISMISS_MS);
    },
    [clearTimer],
  );

  // Clear the banner whenever the operation's context is left (route change), so feedback never
  // carries onto the next screen — the lifetime guarantee that no longer relies on keying a
  // component to a fresh mutation observer (#321 / #323).
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    dismiss();
  }, [pathname, dismiss]);

  // Drop any pending timer on unmount.
  useEffect(() => clearTimer, [clearTimer]);

  // The provider re-renders on every route change (useRouterState above), so memoize the value to
  // keep consumer re-renders tied to an actual message change, not to navigation. showError/dismiss
  // are already stable.
  const value = useMemo(
    () => ({ message, showError, dismiss }),
    [message, showError, dismiss],
  );

  return (
    <ErrorBannerContext.Provider value={value}>
      {children}
    </ErrorBannerContext.Provider>
  );
}

/** Read a stable `showError` (and `dismiss`) to report an operation failure from any component. */
export function useErrorBanner() {
  return useContext(ErrorBannerContext);
}

// The visual banner, rendered once at the top of the app content. Returns null when there is
// nothing to show.
export function ErrorBanner() {
  const { message, dismiss } = useContext(ErrorBannerContext);
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mx-auto mb-4 flex max-w-content items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button
        type="button"
        aria-label="Dismiss error"
        onClick={dismiss}
        className="shrink-0 rounded p-0.5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
