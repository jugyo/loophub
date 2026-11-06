// The issue screens' bottom dock: one tab per live New issue terminal of the repo. A New issue launch
// opens it on the terminal it started (useTerminalLauncher). A tab's close button ends its terminal at
// once, with no confirmation: the History tab lists every past New issue to restore instead.

import { useState } from "react";
import type { IssueTerminalHistory } from "@/api/types";
import { useRequestedIssueTerminal } from "@/components/terminal-controller";
import { isLoopbackPage, TerminalDock } from "@/components/terminal-dock";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import { relativeTime } from "@/lib/time";
import {
  useCloseIssueTerminal,
  useIssueTerminalHistory,
  useIssueTerminals,
  useRestoreIssueTerminal,
} from "@/queries/pull-terminals";
import { useRepo } from "@/queries/repos";
import { codingAgentLabel } from "../../../core/runtimes.ts";

export function IssueTerminalDock({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const repoQuery = useRepo(owner, repo);
  if (repoQuery.data?.terminal_backend !== "herdr-core" || !isLoopbackPage())
    return null;
  const full = `${owner}/${repo}`;
  return <Dock key={full} full={full} />;
}

function Dock({ full }: { full: string }) {
  const query = useIssueTerminals(full);
  const request = useRequestedIssueTerminal(full);
  const close = useCloseIssueTerminal();
  const { showError } = useToast();
  // The terminal a restore started, for the dock to open on like a New issue launch.
  const [restored, setRestored] = useState<string | null>(null);
  return (
    <TerminalDock
      repo={full}
      terminals={query.data?.terminals ?? []}
      isError={query.isError}
      requestedAddress={request.address ?? restored}
      onRequestHandled={() => {
        request.handled();
        setRestored(null);
        // The launch recorded the terminal; don't wait for its event to list it.
        void query.refetch();
      }}
      onClose={(terminal) =>
        close.mutate(
          { repo: full, address: terminal.address },
          {
            onError: (error) =>
              showError(
                `Failed to close ${terminal.label}: ${errorMessage(error)}`,
              ),
          },
        )
      }
      history={<HistoryTable full={full} onRestored={setRestored} />}
    />
  );
}

function HistoryTable({
  full,
  onRestored,
}: {
  full: string;
  onRestored: (address: string) => void;
}) {
  const query = useIssueTerminalHistory(full);
  const restore = useRestoreIssueTerminal();
  const sessions = query.data?.sessions ?? [];
  if (query.isError)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        Failed to load New issue history.
      </p>
    );
  if (query.isSuccess && sessions.length === 0)
    return (
      <p className="p-3 text-sm text-muted-foreground">No past New issues.</p>
    );
  return (
    <div>
      {restore.isError ? (
        <p
          role="alert"
          className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          Failed to restore: {errorMessage(restore.error)}
        </p>
      ) : null}
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-1.5 font-medium">New issue</th>
            <th className="px-3 py-1.5 font-medium">Runtime</th>
            <th className="px-3 py-1.5 font-medium">Last active</th>
            <th className="px-3 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.session_id} className="border-b">
              <td
                className={
                  session.restore_blocker
                    ? "px-3 py-1.5 text-muted-foreground"
                    : "px-3 py-1.5"
                }
              >
                {historyTitle(session)}
              </td>
              <td className="px-3 py-1.5">
                {session.runtime ? codingAgentLabel(session.runtime) : "—"}
              </td>
              <td className="px-3 py-1.5">
                {relativeTime(session.updated_at)}
              </td>
              <td className="px-3 py-1.5 text-right">
                {session.restore_blocker ? (
                  <span className="text-muted-foreground">
                    {session.restore_blocker}
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={restore.isPending}
                    onClick={() =>
                      restore.mutate(
                        { repo: full, sessionId: session.session_id },
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function historyTitle(session: IssueTerminalHistory): string {
  return session.issue
    ? `#${session.issue.number} ${session.issue.title}`
    : `Not filed — started ${new Date(session.started_at).toLocaleString()}`;
}
