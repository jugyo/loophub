// The issue screens' bottom dock: one tab per live New issue terminal of the repo. A New issue launch
// opens it on the terminal it started (useTerminalLauncher).

import { useRequestedIssueTerminal } from "@/components/terminal-controller";
import { isLoopbackPage, TerminalDock } from "@/components/terminal-dock";
import { useIssueTerminals } from "@/queries/pull-terminals";
import { useRepo } from "@/queries/repos";

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
  return (
    <TerminalDock
      repo={full}
      terminals={query.data?.terminals ?? []}
      isError={query.isError}
      requestedAddress={request.address}
      onRequestHandled={() => {
        request.handled();
        // The launch recorded the terminal; don't wait for its event to list it.
        void query.refetch();
      }}
    />
  );
}
