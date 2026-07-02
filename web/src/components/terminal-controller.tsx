// Herdr launch state shared across the app: consumers (New Issue / Build / Resume buttons) call
// useTerminalLauncher() to start a Herdr session, and the shell (app-layout.tsx) renders the
// resulting feedback / error dialog here.
//
// The context defaults to null, so useTerminalLauncher()'s feedback calls are safe no-ops when
// there is no provider (e.g. unit tests), mirroring the defensive default in detail-title.tsx.

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
import { ApiError } from "@/api/client";
import { useErrorBanner } from "@/components/error-banner";
import {
  type HerdrLaunchError,
  HerdrLaunchErrorDialog,
} from "@/components/herdr-launch-error-dialog";
import { useLaunchTerminalWorkflow } from "@/queries/terminal";

// Options for launching a Herdr terminal session. All optional except `repo` and `workflow`,
// which useTerminalLauncher requires.
export interface OpenTerminalOptions {
  // "owner/name" of the repo whose base dir becomes the session's cwd, or "" for $HOME.
  repo?: string;
  // Session label override; defaults to the repo name (or "~" for $HOME).
  label?: string;
  // Semantic workflow the Herdr session runs — it does not replay a literal shell command.
  workflow?: "issue-dev" | "issue-create" | "resume" | "github-pr-export";
  issueNumber?: number;
  prNumber?: number;
  session?: string;
  cwd?: string;
}

export type OpenTerminal = (opts?: OpenTerminalOptions) => void;

interface TerminalControllerValue {
  launchMessage: string | null;
  showLaunchMessage: (message: string) => void;
  dismissLaunchMessage: () => void;
  // Overlay dialog state for a failed Herdr launch (#483) — kept separate from launchMessage
  // (success feedback) since it needs a richer payload (reason + example command) and stays
  // until the user dismisses it, rather than auto-clearing.
  herdrLaunchError: HerdrLaunchError | null;
  showHerdrLaunchError: (error: HerdrLaunchError) => void;
  dismissHerdrLaunchError: () => void;
}

const TerminalControllerContext = createContext<TerminalControllerValue | null>(
  null,
);

export function TerminalControllerProvider({
  children,
}: {
  children: ReactNode;
}) {
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

  const [herdrLaunchError, setHerdrLaunchError] =
    useState<HerdrLaunchError | null>(null);
  const dismissHerdrLaunchError = useCallback(
    () => setHerdrLaunchError(null),
    [],
  );
  const showHerdrLaunchError = useCallback((error: HerdrLaunchError) => {
    setHerdrLaunchError(error);
  }, []);

  const value = useMemo<TerminalControllerValue>(
    () => ({
      launchMessage,
      showLaunchMessage,
      dismissLaunchMessage,
      herdrLaunchError,
      showHerdrLaunchError,
      dismissHerdrLaunchError,
    }),
    [
      launchMessage,
      showLaunchMessage,
      dismissLaunchMessage,
      herdrLaunchError,
      showHerdrLaunchError,
      dismissHerdrLaunchError,
    ],
  );
  return (
    <TerminalControllerContext.Provider value={value}>
      {children}
    </TerminalControllerContext.Provider>
  );
}

export function useTerminalLauncher(): { launchTerminal: OpenTerminal } {
  const ctx = useContext(TerminalControllerContext);
  const launch = useLaunchTerminalWorkflow();
  const { showError } = useErrorBanner();
  const launchTerminal = useCallback<OpenTerminal>(
    (opts) => {
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
          issueNumber: opts.issueNumber,
          prNumber: opts.prNumber,
          session: opts.session,
          cwd: opts.cwd,
        },
        {
          onSuccess: (result) => {
            // Resume dedup (#578): the backend switched focus to an already-running terminal
            // instead of starting a new one — say so instead of the generic "Launched in ..."
            // message, which would misleadingly imply a fresh agent just started.
            if (result.focused) {
              ctx?.showLaunchMessage("Switched to the existing terminal.");
              return;
            }
            const session = result.session_name ?? "Herdr";
            const attach = result.attach ? ` Attach: ${result.attach}` : "";
            ctx?.showLaunchMessage(`Launched in ${session}.${attach}`);
          },
          onError: (e) =>
            ctx?.showHerdrLaunchError({
              reason: e instanceof Error ? e.message : "Herdr launch failed.",
              command: e instanceof ApiError ? e.data?.command : undefined,
              session: e instanceof ApiError ? e.data?.session : undefined,
            }),
        },
      );
    },
    [ctx, launch, showError],
  );
  return { launchTerminal };
}

export function TerminalLaunchFeedback() {
  const ctx = useContext(TerminalControllerContext);
  if (!ctx?.launchMessage) return null;
  return (
    <div className="mx-auto mb-4 flex max-w-content items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-900 dark:text-emerald-100">
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

// Overlay dialog shown for a failed Herdr launch (#483), in place of the generic ErrorBanner.
export function TerminalLaunchErrorDialog() {
  const ctx = useContext(TerminalControllerContext);
  if (!ctx?.herdrLaunchError) return null;
  return (
    <HerdrLaunchErrorDialog
      error={ctx.herdrLaunchError}
      onClose={ctx.dismissHerdrLaunchError}
    />
  );
}
