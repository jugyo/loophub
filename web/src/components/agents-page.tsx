// Global Agents page (/agents, #1551): every LoopHub-managed herdr session as a tree root,
// with PR-linked workspaces and other agents underneath. Reuses terminal/sessions + AgentTree
// so Open in Herdr / bot-icon status match the PR Agents UI.

import { Link } from "@tanstack/react-router";
import { GitPullRequest, Loader2 } from "lucide-react";
import type { HerdrAgent, HerdrRepoSessions, HerdrSessions } from "@/api/types";
import { AgentTree } from "@/components/pull-herdr-section";
import { useHerdrSessions } from "@/queries/terminal";

export type PullWorkspaceGroup = {
  pull: number;
  agents: HerdrAgent[];
};

export type SessionTree = {
  repo: string;
  sessionName: string;
  owner: string;
  name: string;
  pullWorkspaces: PullWorkspaceGroup[];
  otherAgents: HerdrAgent[];
};

/** Group a session's agents into PR-linked workspaces and everything else. */
export function buildSessionTree(group: HerdrRepoSessions): SessionTree | null {
  const slash = group.repo.indexOf("/");
  if (slash <= 0 || slash === group.repo.length - 1) return null;
  const owner = group.repo.slice(0, slash);
  const name = group.repo.slice(slash + 1);
  const byPull = new Map<number, HerdrAgent[]>();
  const otherAgents: HerdrAgent[] = [];
  for (const agent of group.agents) {
    if (agent.pull == null) {
      otherAgents.push(agent);
      continue;
    }
    const list = byPull.get(agent.pull);
    if (list) list.push(agent);
    else byPull.set(agent.pull, [agent]);
  }
  const pullWorkspaces = [...byPull.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pull, agents]) => ({ pull, agents }));
  if (pullWorkspaces.length === 0 && otherAgents.length === 0) return null;
  return {
    repo: group.repo,
    sessionName: group.session_name,
    owner,
    name,
    pullWorkspaces,
    otherAgents,
  };
}

export function buildAgentsTrees(
  data: HerdrSessions | undefined,
): SessionTree[] {
  if (!data?.repos?.length) return [];
  return data.repos
    .map(buildSessionTree)
    .filter((tree): tree is SessionTree => tree != null);
}

export function AgentsPage() {
  const { data, isLoading, isError } = useHerdrSessions();
  const trees = buildAgentsTrees(data);

  return (
    <div className="mx-auto flex max-w-content flex-col">
      <h1 className="text-2xl font-semibold">Agents</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        LoopHub-managed herdr sessions, their PR worktrees, and running agents.
      </p>

      <div className="mt-6">
        {isLoading && !data ? (
          <p
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading herdr sessions…
          </p>
        ) : isError && !data ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
          >
            Failed to load Agents.
          </div>
        ) : trees.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            No herdr sessions with agents.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {isError ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
              >
                Failed to refresh Agents. Showing last successful data.
              </div>
            ) : null}
            {trees.map((tree) => (
              <SessionSection
                key={`${tree.repo}:${tree.sessionName}`}
                tree={tree}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionSection({ tree }: { tree: SessionTree }) {
  return (
    <section
      aria-label={`Herdr session ${tree.sessionName}`}
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <header className="flex min-w-0 flex-col gap-0.5">
        <h2
          className="truncate text-base font-semibold"
          title={tree.sessionName}
        >
          {tree.sessionName}
        </h2>
        <p className="truncate text-sm text-muted-foreground" title={tree.repo}>
          {tree.repo}
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {tree.pullWorkspaces.map((workspace) => (
          <PullWorkspaceSection
            key={workspace.pull}
            owner={tree.owner}
            repo={tree.name}
            workspace={workspace}
          />
        ))}
        {tree.otherAgents.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              Other workspaces
            </h3>
            <AgentTree
              owner={tree.owner}
              repo={tree.name}
              agents={tree.otherAgents}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PullWorkspaceSection({
  owner,
  repo,
  workspace,
}: {
  owner: string;
  repo: string;
  workspace: PullWorkspaceGroup;
}) {
  // Convention dir name is available from the PR number without a server-side path.
  const worktreeDir = `pr-${workspace.pull}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
        <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <GitPullRequest
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <Link
            to="/r/$owner/$repo/pulls/$number"
            params={{
              owner,
              repo,
              number: String(workspace.pull),
            }}
            className="truncate text-foreground underline-offset-2 hover:underline"
            title={`PR #${workspace.pull}`}
          >
            PR #{workspace.pull}
          </Link>
        </h3>
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={`git worktree ${worktreeDir}`}
        >
          worktree {worktreeDir}
        </p>
      </div>
      <AgentTree owner={owner} repo={repo} agents={workspace.agents} />
    </div>
  );
}
