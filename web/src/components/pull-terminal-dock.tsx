// The PR screen's bottom dock (#2574): one tab per live agent terminal of the PR's Workflow runs, plus
// an inactive tab for each agent of a running run whose terminal is gone, which can resume its session
// in a new terminal. New terminal opens the person's own shell in the PR's worktree as another tab.

import { Plus } from "lucide-react";
import { useState } from "react";
import type { LostPullTerminal } from "@/api/types";
import { isLoopbackPage, TerminalDock } from "@/components/terminal-dock";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import {
  useOpenPullShell,
  usePullTerminals,
  useRestorePullTerminal,
} from "@/queries/pull-terminals";
import { useRepo } from "@/queries/repos";

export function PullTerminalDock({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const repoQuery = useRepo(owner, repo);
  if (repoQuery.data?.terminal_backend !== "herdr-core" || !isLoopbackPage())
    return null;
  return <Dock key={number} owner={owner} repo={repo} number={number} />;
}

function Dock({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const query = usePullTerminals(owner, repo, number);
  // The terminal a restore or New terminal started, for the dock to open on.
  const [restored, setRestored] = useState<string | null>(null);
  const openShell = useOpenPullShell();
  const { showError } = useToast();
  const shellBlocker = query.data?.shell_blocker ?? null;
  async function onStarted(address: string) {
    // The launch recorded the terminal; list it before selecting it.
    await query.refetch();
    setRestored(address);
  }
  return (
    <TerminalDock
      repo={`${owner}/${repo}`}
      pull={number}
      terminals={query.data?.terminals ?? []}
      isError={query.isError}
      selectFirstTab
      requestedAddress={restored}
      onRequestHandled={() => setRestored(null)}
      inactive={(query.data?.lost ?? []).map((agent) => ({
        key: `lost:${agent.session_id}`,
        label: agent.label,
        title: agent.restore_blocker ?? "The terminal is no longer running",
        content: (
          <LostAgent
            repo={`${owner}/${repo}`}
            pull={number}
            agent={agent}
            onRestored={onStarted}
          />
        ),
      }))}
      actions={
        // A disabled button gets no hover, so the reason sits on its wrapper.
        <span title={shellBlocker ?? "Open a shell in this PR's worktree"}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={
              !query.data || shellBlocker !== null || openShell.isPending
            }
            onClick={() =>
              openShell.mutate(
                { repo: `${owner}/${repo}`, pull: number },
                {
                  onSuccess: (result) =>
                    result.address && onStarted(result.address),
                  onError: (error) =>
                    showError(
                      `Failed to open a terminal: ${errorMessage(error)}`,
                    ),
                },
              )
            }
          >
            <Plus className="size-3.5" aria-hidden="true" />
            New terminal
          </Button>
        </span>
      }
    />
  );
}

function LostAgent({
  repo,
  pull,
  agent,
  onRestored,
}: {
  repo: string;
  pull: number;
  agent: LostPullTerminal;
  onRestored: (address: string) => void;
}) {
  const restore = useRestorePullTerminal();
  return (
    <div className="space-y-2 p-3 text-sm">
      <p className="text-muted-foreground">
        The terminal of {agent.label} is no longer running.
      </p>
      {agent.restore_blocker ? (
        <p className="text-muted-foreground">{agent.restore_blocker}</p>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={restore.isPending}
          onClick={() =>
            restore.mutate(
              { repo, pull, sessionId: agent.session_id },
              {
                onSuccess: (result) =>
                  result.address && onRestored(result.address),
              },
            )
          }
        >
          Restore
        </Button>
      )}
      {restore.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Failed to restore: {errorMessage(restore.error)}
        </p>
      ) : null}
    </div>
  );
}
