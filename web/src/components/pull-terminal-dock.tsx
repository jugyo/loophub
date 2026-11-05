// The PR screen's bottom dock (#2574): one tab per live agent terminal of the PR's Workflow runs.

import { isLoopbackPage, TerminalDock } from "@/components/terminal-dock";
import { usePullTerminals } from "@/queries/pull-terminals";
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
  return (
    <TerminalDock
      repo={`${owner}/${repo}`}
      pull={number}
      terminals={query.data?.terminals ?? []}
      isError={query.isError}
    />
  );
}
