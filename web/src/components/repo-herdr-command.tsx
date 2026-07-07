// #878: subtle, copyable herdr start/connect command on the repo page top (/r/:owner/:repo).
// `herdr --session <name>` connects to the repo's existing herdr session if one is running and
// starts it otherwise, so a single command covers both. The session name is the deterministic one
// every LoopHub herdr launch derives (core/terminal-launch.ts's herdrSessionName), served on the
// repo wire object (repo.herdr_session_name) so this needs no herdr call. Rendered between the
// repo title and the "Issues" header with a one-line explanation, kept low-key (muted, small,
// monospace command) so it doesn't compete with the issue list below.

import { Terminal } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { useRepo } from "@/queries/repos";

export function RepoHerdrCommand({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const { data } = useRepo(owner, repo);
  const sessionName = data?.herdr_session_name;
  // Render nothing until the repo (and its session name) has loaded — the command is a nicety,
  // not something worth a loading state on the repo page top.
  if (!sessionName) return null;
  const command = `herdr --session ${sessionName}`;

  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p>Run in a terminal to open (or start) this repo's herdr session:</p>
      <div className="flex items-center gap-1">
        <Terminal className="size-3.5 shrink-0" aria-hidden="true" />
        <code
          className="truncate rounded bg-muted px-1.5 py-0.5 font-mono"
          title={command}
        >
          {command}
        </code>
        <CopyButton
          value={command}
          label="Copy herdr session command"
          className="size-6"
        />
      </div>
    </div>
  );
}
