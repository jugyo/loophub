// Bridges the bottom terminal pane to the rest of the app so any component can open a terminal
// tab with a specific command. The pane (terminal-pane.tsx) owns the tab state; it publishes its
// imperative `openTerminal` here via useRegisterTerminalController, and consumers (the New Issue /
// Build buttons) read a stable `openTerminal` via useTerminal().
//
// The published fn is held in a ref so a consumer's `openTerminal` identity stays stable (no
// re-renders) and the latest pane implementation is always called. The context defaults to null,
// so useTerminal() is a safe no-op when there is no provider (e.g. unit tests), mirroring the
// defensive default in detail-title.tsx.

import { ExternalLink, X } from "lucide-react";
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
import { useErrorBanner } from "@/components/error-banner";
import {
  useLaunchTerminalWorkflow,
  useTerminalLaunchConfig,
} from "@/queries/terminal";

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
  // Semantic workflow for non-builtin backends that should not replay the literal command.
  workflow?: "issue-dev" | "issue-create" | "resume" | "github-pr-export";
  issueNumber?: number;
  prNumber?: number;
  session?: string;
  cwd?: string;
}

export type OpenTerminal = (opts?: OpenTerminalOptions) => void;

const noop: OpenTerminal = () => {};

interface TerminalControllerValue {
  // Ref to the live open fn published by the mounted terminal pane.
  ref: React.MutableRefObject<OpenTerminal>;
  launchMessage: string | null;
  showLaunchMessage: (message: string) => void;
  dismissLaunchMessage: () => void;
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
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissLaunchMessage = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setLaunchMessage(null);
  }, []);
  const showLaunchMessage = useCallback(
    (message: string) => {
      dismissLaunchMessage();
      setLaunchMessage(message);
      timer.current = setTimeout(() => {
        timer.current = null;
        setLaunchMessage(null);
      }, 12000);
    },
    [dismissLaunchMessage],
  );
  useEffect(() => dismissLaunchMessage, [dismissLaunchMessage]);
  // Stable context value: the ref identity never changes, so consumers never re-render when the
  // pane republishes a new implementation.
  const value = useMemo<TerminalControllerValue>(
    () => ({
      ref,
      launchMessage,
      showLaunchMessage,
      dismissLaunchMessage,
    }),
    [launchMessage, showLaunchMessage, dismissLaunchMessage],
  );
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

export function useTerminalLauncher(): { launchTerminal: OpenTerminal } {
  const ctx = useContext(TerminalControllerContext);
  const { openTerminal } = useTerminal();
  const config = useTerminalLaunchConfig();
  const launch = useLaunchTerminalWorkflow();
  const { showError } = useErrorBanner();
  const launchTerminal = useCallback<OpenTerminal>(
    (opts) => {
      if (!config.isSuccess) {
        showError("Terminal backend is still loading.");
        return;
      }
      if (config.data.backend === "builtin") {
        openTerminal(opts);
        return;
      }
      if (!opts?.repo) {
        showError("Herdr launch failed: repo is required.");
        return;
      }
      if (!opts.workflow) {
        showError("Herdr launch failed: workflow is required.");
        return;
      }
      launch.mutate(
        {
          repo: opts.repo,
          label: opts.label,
          workflow: opts.workflow,
          issueNumber: opts.issueNumber ?? opts.issueRef?.number,
          prNumber: opts.prNumber,
          session: opts.session,
          cwd: opts.cwd,
        },
        {
          onSuccess: (result) => {
            const session = result.session_name ?? "Herdr";
            const attach = result.attach ? ` Attach: ${result.attach}` : "";
            ctx?.showLaunchMessage(`Launched in ${session}.${attach}`);
          },
          onError: (e) =>
            showError(
              e instanceof Error
                ? `Herdr launch failed: ${e.message}`
                : "Herdr launch failed.",
            ),
        },
      );
    },
    [
      config.data?.backend,
      config.isSuccess,
      ctx,
      launch,
      openTerminal,
      showError,
    ],
  );
  return { launchTerminal };
}

export function TerminalLaunchFeedback() {
  const ctx = useContext(TerminalControllerContext);
  if (!ctx?.launchMessage) return null;
  return (
    <div className="mx-auto mb-4 flex max-w-content items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-900 dark:text-emerald-100">
      <ExternalLink className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{ctx.launchMessage}</span>
      <button
        type="button"
        aria-label="Dismiss launch feedback"
        onClick={ctx.dismissLaunchMessage}
        className="shrink-0 rounded p-0.5 opacity-70 hover:bg-emerald-500/10 hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
