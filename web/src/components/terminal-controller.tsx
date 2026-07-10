// Herdr launch state shared across the app: consumers (New Issue / Build / Resume buttons) call
// useTerminalLauncher() to start a Herdr session, and the shell (app-layout.tsx) renders the
// resulting feedback / error dialog here.
//
// The context defaults to null, so useTerminalLauncher()'s feedback calls are safe no-ops when
// there is no provider (e.g. unit tests), mirroring the defensive default in detail-title.tsx.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { ApiError } from "@/api/client";
import type { CodingAgent } from "@/api/types";
import {
  type HerdrLaunchError,
  HerdrLaunchErrorDialog,
} from "@/components/herdr-launch-error-dialog";
import { useToast } from "@/components/toast";
import { useLaunchTerminalWorkflow } from "@/queries/terminal";

// Options for launching a Herdr terminal session. All optional except `repo` and `workflow`,
// which useTerminalLauncher requires.
export interface OpenTerminalOptions {
  // "owner/name" of the repo whose base dir becomes the session's cwd, or "" for $HOME.
  repo?: string;
  // Session label override; defaults to the repo name (or "~" for $HOME).
  label?: string;
  // Semantic workflow the Herdr session runs — it does not replay a literal shell command.
  workflow?:
    | "issue-dev"
    | "issue-create"
    | "scheduled-task-create"
    | "resume"
    | "github-pr-export"
    | "workflow-run";
  issueNumber?: number;
  prNumber?: number;
  // Saved workflow id for a "workflow-run" launch (#1007) — the issue-detail Start workflow
  // dropdown sets it; maps to `lh workflow start ... --workflow-id <id>`.
  workflowId?: number;
  session?: string;
  cwd?: string;
  // One-shot agent/model override for an issue-dev (Build) launch (#637) — the issue-detail Build
  // dropdown sets these; the plain Build button omits them. They apply to this launch only.
  agent?: CodingAgent;
  model?: string;
}

export type OpenTerminal = (opts?: OpenTerminalOptions) => void;

interface TerminalControllerValue {
  // Overlay dialog state for a failed Herdr launch (#483). It needs a richer payload
  // (reason + example command) and stays until the user dismisses it, rather than auto-clearing.
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
      herdrLaunchError,
      showHerdrLaunchError,
      dismissHerdrLaunchError,
    }),
    [herdrLaunchError, showHerdrLaunchError, dismissHerdrLaunchError],
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
  const { showError } = useToast();
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
          workflowId: opts.workflowId,
          session: opts.session,
          cwd: opts.cwd,
          agent: opts.agent,
          model: opts.model,
        },
        {
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

// Overlay dialog shown for a failed Herdr launch (#483), in place of the generic toast.
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
