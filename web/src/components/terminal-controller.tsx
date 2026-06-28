// Bridges the bottom terminal pane to the rest of the app so any component can open a terminal
// tab with a specific command. The pane (terminal-pane.tsx) owns the tab state; it publishes its
// imperative `openTerminal` here via useRegisterTerminalController, and consumers (the New Issue /
// Build buttons) read a stable `openTerminal` via useTerminal().
//
// The published fn is held in a ref so a consumer's `openTerminal` identity stays stable (no
// re-renders) and the latest pane implementation is always called. The context defaults to null,
// so useTerminal() is a safe no-op when there is no provider (e.g. unit tests), mirroring the
// defensive default in detail-title.tsx.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";

// An issue this terminal tab is working on (set when opened from the issue Build button). The
// terminal pane uses it to render a top region that resolves and surfaces the linked PR — issue
// number, not PR number, because at Build time the PR may not exist yet (`lh dev` opens it).
export interface TerminalIssueRef {
  owner: string;
  repo: string;
  number: number;
}

// Options for opening a terminal tab. All optional: no command opens a plain shell, and an empty
// repo roots the shell at $HOME (resolved server-side).
export interface OpenTerminalOptions {
  // Command to type into the shell once it is interactive (it stays interactive afterward).
  command?: string;
  // "owner/name" of the repo whose base dir becomes the cwd, or "" for $HOME.
  repo?: string;
  // Tab label override; defaults to the repo name (or "~" for $HOME).
  label?: string;
  // The issue this tab is building (Build button only) — drives the PR top region in the pane.
  issueRef?: TerminalIssueRef;
}

export type OpenTerminal = (opts?: OpenTerminalOptions) => void;

const noop: OpenTerminal = () => {};

interface TerminalControllerValue {
  // Ref to the live open fn published by the mounted terminal pane.
  ref: React.MutableRefObject<OpenTerminal>;
}

const TerminalControllerContext = createContext<TerminalControllerValue | null>(
  null,
);

export function TerminalControllerProvider({
  children,
}: {
  children: ReactNode;
}) {
  const ref = useRef<OpenTerminal>(noop);
  // Stable context value: the ref identity never changes, so consumers never re-render when the
  // pane republishes a new implementation.
  const value = useRef<TerminalControllerValue>({ ref }).current;
  return (
    <TerminalControllerContext.Provider value={value}>
      {children}
    </TerminalControllerContext.Provider>
  );
}

// Publish the terminal pane's imperative open fn so consumers can call it. Called by the pane with
// its own `openTerminal`; the latest is kept in the shared ref and cleared on unmount.
export function useRegisterTerminalController(
  openTerminal: OpenTerminal,
): void {
  const ctx = useContext(TerminalControllerContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.ref.current = openTerminal;
    return () => {
      ctx.ref.current = noop;
    };
  }, [ctx, openTerminal]);
}

// Read a stable `openTerminal` to open a terminal tab from any component. No-op (without a
// provider, or before the pane mounts) so callers never need to guard.
export function useTerminal(): { openTerminal: OpenTerminal } {
  const ctx = useContext(TerminalControllerContext);
  const openTerminal = useCallback<OpenTerminal>(
    (opts) => {
      ctx?.ref.current(opts);
    },
    [ctx],
  );
  return { openTerminal };
}
