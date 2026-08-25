// Herdr launch state shared across the app: consumers call
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
    | "issue-create"
    | "workflow-create"
    | "github-pr-export"
    | "workflow-run";
  issueNumber?: number;
  prNumber?: number;
  // Saved workflow id for a "workflow-run" launch (#1007) — the issue-detail Start workflow
  // dropdown sets it; maps to `lh workflow start ... --workflow-id <id>`.
  workflowId?: number;
  targetBranch?: string;
  parentIssue?: number;
  // Direct initial prompt for launches that should not invoke a slash-command skill.
  prompt?: string;
  // One-shot agent/model/effort override for the issue-create (New issue) launch. Plain
  // buttons omit them so the CLI resolves the repo's effective config; dropdown selections
  // apply to this launch only (#1275/#1534).
  agent?: CodingAgent;
  model?: string;
  effort?: string;
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

// `launchFailed` reports that this consumer's most recent launch was rejected (#2383). The error
// itself is already surfaced by the dialog; callers that put a button into an optimistic
// "working…" state on click need the failure too, so they can drop it instead of leaving a
// disabled button behind for an agent that never started. Scoped per call site: each
// useTerminalLauncher() owns its own mutation, so one surface's failure never disables another's.
// It covers rejected launches only — the argument checks below report through the toast and return
// without dispatching one, so they never raise this flag. Callers that can actually reach those
// (they pass a repo/workflow that may be missing) need their own handling for that path.
export function useTerminalLauncher(): {
  launchTerminal: OpenTerminal;
  launchFailed: boolean;
} {
  const ctx = useContext(TerminalControllerContext);
  const launch = useLaunchTerminalWorkflow();
  const { showError } = useToast();
  const launchTerminal = useCallback<OpenTerminal>(
    (opts) => {
      // The global "workflow-create" (New workflow) launch has no repo (#1889); every other
      // workflow requires one.
      if (!opts?.repo && opts?.workflow !== "workflow-create") {
        showError("Herdr launch failed: repo is required.");
        return;
      }
      if (!opts?.workflow) {
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
          targetBranch: opts.targetBranch,
          parentIssue: opts.parentIssue,
          prompt: opts.prompt,
          agent: opts.agent,
          model: opts.model,
          effort: opts.effort,
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
  return { launchTerminal, launchFailed: launch.isError };
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
