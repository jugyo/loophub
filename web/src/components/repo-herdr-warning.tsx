// Shared warning for every repo-scoped route when its deterministic herdr session is confirmed
// absent. The existing terminal/sessions poll provides the running state; missing or failed state
// stays silent so old servers and transient herdr failures never produce a false warning.

import { TriangleAlert } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { useRepos } from "@/queries/repos";
import { useHerdrSessions } from "@/queries/terminal";

export function RepoHerdrWarning() {
  const currentRepo = useCurrentRepo();
  const { data: repos } = useRepos();
  const { data: sessions, isError } = useHerdrSessions({
    enabled: currentRepo !== null,
  });
  const runningRepos = sessions?.running_repos;
  const repo = repos?.find((candidate) => candidate.full_name === currentRepo);
  const sessionName = repo?.herdr_session_name;

  if (
    currentRepo === null ||
    !sessionName ||
    isError ||
    runningRepos === undefined ||
    runningRepos.includes(currentRepo)
  ) {
    return null;
  }
  const command = `herdr --session ${sessionName}`;

  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100 sm:px-6"
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-medium">
        Herdr session is not running.
      </span>
      <span className="text-amber-800 dark:text-amber-200">Start it with:</span>
      <div className="flex min-w-0 items-center gap-1">
        <code
          className="truncate rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs dark:bg-amber-900"
          title={command}
        >
          {command}
        </code>
        <CopyButton
          value={command}
          label="Copy herdr session command"
          className="size-6 text-amber-800 hover:bg-amber-200 hover:text-amber-950 dark:text-amber-200 dark:hover:bg-amber-800 dark:hover:text-amber-50"
        />
      </div>
    </div>
  );
}
