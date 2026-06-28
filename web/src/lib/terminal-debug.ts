// Diagnostic instrumentation for #275: the embedded terminal resets to a fresh shell after the
// machine sleeps or the screen locks, and we don't yet know whether that is a page reload, an
// abnormal WebSocket close, or a React remount. This module is OBSERVABILITY ONLY — it changes no
// behavior; it just emits the console logs needed to tell those apart once the bug is reproduced.
// All output goes through a single prefix so it can be filtered (and removed) in one place.
//
// How to read the logs (DevTools Console, filter "[term-debug]"):
//   - page=<id> is minted once per page execution. If it changes across a sleep/resume, the page
//     was reloaded/discarded (hypothesis 1). If it stays the same, the SPA kept running.
//   - a `ws onclose`/`ws onerror` without a page change points at the socket path (hypothesis 2).
//   - `freeze`/`resume`/`pageshow persisted=true` reveal browser Page Lifecycle transitions.
// See also DevTools > Application > Back/forward cache & Lifecycle for the freeze/discard state.

const PREFIX = "[term-debug]";

// Minted once when this module is first evaluated. A reload (or tab discard → restore) re-runs the
// bundle, producing a new id — so a changed `page=` in the console *is* the reload signal.
export const PAGE_LOAD_ID = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

// PerformanceNavigationTiming.type: "navigate" | "reload" | "back_forward" | "prerender".
// Tells a hard reload apart from a fresh navigation at load time.
function navigationType(): string {
  const [nav] = performance.getEntriesByType(
    "navigation",
  ) as PerformanceNavigationTiming[];
  return nav?.type ?? "unknown";
}

/**
 * Emit one diagnostic line. `event` is a short stable tag; `detail` is optional structured
 * context. Time is stamped two ways: wall-clock ISO (correlate with when you triggered sleep)
 * and `performance.now()` ms since page start (monotonic; survives clock jumps on resume).
 */
export function tlog(event: string, detail?: Record<string, unknown>): void {
  const at = `+${Math.round(performance.now())}ms`;
  console.log(
    `${PREFIX} ${new Date().toISOString()} ${at} page=${PAGE_LOAD_ID} ${event}`,
    detail ?? "",
  );
}

// Register the page-global Page Lifecycle / connectivity listeners once. Component-scoped events
// (mount/unmount, socket open/close) are logged from the components themselves; these are the
// window/document-level signals that exist independent of any single terminal. Idempotent so it is
// safe to call from every TerminalPane mount.
let installed = false;
export function installTerminalDebugLogging(): void {
  if (installed) return;
  installed = true;

  tlog("page-load", {
    navigationType: navigationType(),
    visibility: document.visibilityState,
    url: location.href,
  });

  document.addEventListener("visibilitychange", () =>
    tlog("visibilitychange", { state: document.visibilityState }),
  );
  // Page Lifecycle API: freeze/resume bracket a tab being frozen (CPU suspended) and thawed —
  // the most likely shape of a sleep/long-idle transition that doesn't fully reload.
  document.addEventListener("freeze", () => tlog("freeze"));
  document.addEventListener("resume", () => tlog("resume"));
  // pagehide/pageshow with persisted=true mean the page entered/left the back/forward cache
  // (alive but detached) rather than being torn down — distinct from a reload.
  window.addEventListener("pagehide", (e) =>
    tlog("pagehide", { persisted: e.persisted }),
  );
  window.addEventListener("pageshow", (e) =>
    tlog("pageshow", { persisted: e.persisted }),
  );
  window.addEventListener("online", () => tlog("online"));
  window.addEventListener("offline", () => tlog("offline"));
}
