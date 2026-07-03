// Floating toast notifications (#574) — the shared replacement for the two banners that used to
// push page content down: the operation-failure ErrorBanner (#323) and the herdr launch success
// message in terminal-controller.tsx. Toasts float above the main content in a fixed viewport
// instead of reserving layout space, so opening/closing one never shifts anything underneath.
//
//   - each toast auto-dismisses after a per-variant timeout (success/error durations match what
//     the banners they replace used),
//   - each has a close (×) button for immediate manual dismissal, and
//   - every toast is cleared on route change, preserving the "feedback never outlives the
//     operation's context" guarantee from #321/#323.
//
// The context defaults to a no-op so consumers render fine without a provider (e.g. unit tests),
// mirroring detail-title.tsx.

import { useRouterState } from "@tanstack/react-router";
import { CheckCircle2, X, XCircle } from "lucide-react";
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
import { cn } from "@/lib/utils";

export type ToastVariant = "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

// How long a toast stays before it auto-dismisses, carried over from the banners this replaces:
// TerminalLaunchFeedback used 12s, ErrorBanner used 8s (#323).
const AUTO_DISMISS_MS: Record<ToastVariant, number> = {
  success: 12000,
  error: 8000,
};

interface ToastContextValue {
  toasts: ToastItem[];
  showToast: (message: string, variant: ToastVariant) => void;
  dismiss: (id: number) => void;
  dismissAll: () => void;
}

const noop = () => {};

const ToastContext = createContext<ToastContextValue>({
  toasts: [],
  showToast: noop,
  dismiss: noop,
  dismissAll: noop,
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const dismissAll = useCallback(() => {
    for (const timer of timers.current.values()) {
      clearTimeout(timer);
    }
    timers.current.clear();
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (message: string, variant: ToastVariant) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, variant }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS[variant]),
      );
    },
    [dismiss],
  );

  // Clear every toast whenever the operation's context is left (route change), so feedback never
  // carries onto the next screen — the same lifetime guarantee ErrorBanner had (#321/#323), now
  // shared by every toast kind.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    dismissAll();
  }, [pathname, dismissAll]);

  // Drop any pending timers on unmount.
  useEffect(() => dismissAll, [dismissAll]);

  const value = useMemo(
    () => ({ toasts, showToast, dismiss, dismissAll }),
    [toasts, showToast, dismiss, dismissAll],
  );

  return (
    <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
  );
}

/** Show a toast from any component. Prefer this over the raw `showToast(message, variant)`. */
export function useToast() {
  const { showToast } = useContext(ToastContext);
  return {
    showSuccess: useCallback(
      (message: string) => showToast(message, "success"),
      [showToast],
    ),
    showError: useCallback(
      (message: string) => showToast(message, "error"),
      [showToast],
    ),
  };
}

const VARIANT_ICON = {
  success: CheckCircle2,
  error: XCircle,
} as const;

// Opaque `bg-background` (not a low-opacity tint) — this floats over arbitrary page content now,
// so a translucent fill would let that content show through and read as visual noise.
const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success:
    "border-emerald-500/50 bg-background text-emerald-700 dark:text-emerald-300",
  error: "border-destructive/50 bg-background text-destructive",
};

// The floating viewport, rendered once at the app-shell level. Fixed to the top-right corner of
// the viewport (macOS Notification Center style) — narrow, and stacked vertically as more toasts
// appear — so it floats over the content without reserving space in it.
export function ToastViewport() {
  const { toasts, dismiss } = useContext(ToastContext);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed top-4 right-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-2">
      {toasts.map((toast) => {
        const Icon = VARIANT_ICON[toast.variant];
        return (
          <div
            key={toast.id}
            role="alert"
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-md border p-3 text-sm shadow-lg",
              VARIANT_CLASSES[toast.variant],
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{toast.message}</span>
            <button
              type="button"
              aria-label={
                toast.variant === "error"
                  ? "Dismiss error"
                  : "Dismiss notification"
              }
              onClick={() => dismiss(toast.id)}
              className="shrink-0 rounded p-0.5 opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
            >
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
