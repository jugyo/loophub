// Global Agents page (/agents, #1551): every LoopHub-managed herdr session as a tree root,
// with PR-linked workspaces and other agents underneath. Reuses terminal/sessions + AgentTree
// so Open in Herdr / bot-icon status match the PR Agents UI.

import { Link } from "@tanstack/react-router";
import { GitPullRequest, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { HerdrAgent, HerdrRepoSessions, HerdrSessions } from "@/api/types";
import { AgentTree } from "@/components/pull-herdr-section";
import { classifyHerdrSnapshotFreshness } from "@/lib/herdr-snapshot-freshness";
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
  /** Set when this repo's `agent list` capture is failing and these agents are the last known
   * ones (#2142): the ISO time they were captured. */
  staleSince?: string;
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
    ...(group.stale_since ? { staleSince: group.stale_since } : {}),
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
    <div
      data-debug-component="AgentsPage"
      className="mx-auto flex max-w-content flex-col"
    >
      <h1 className="text-2xl font-semibold">Agents</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        LoopHub-managed herdr sessions, their PR worktrees, and running agents.
      </p>

      {data && !isError ? (
        <>
          <HerdrSnapshotStaleness capturedAt={data.captured_at} />
          <HerdrCaptureFailures repos={data.capture_failed_repos} />
        </>
      ) : null}

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

function formatSnapshotAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

// Surfaces the freshness of the worker-owned herdr snapshot (#1665). Since terminal/sessions no
// longer polls, a stopped lh-worker would otherwise never re-render this view — so a display-only
// ticker (no network) re-evaluates captured_at against the wall clock, flipping to a visible
// warning when the snapshot goes stale. This is the "staleness must be visible, no automatic
// fallback" acceptance criterion.
function HerdrSnapshotStaleness({
  capturedAt,
}: {
  capturedAt: string | null | undefined;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const freshness = classifyHerdrSnapshotFreshness(capturedAt, nowMs);
  if (freshness.state === "fresh") {
    // Supplementary muted info; deliberately no live-region role so it does not compete with the
    // page's primary status/empty-state region.
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Snapshot updated {formatSnapshotAge(freshness.ageMs)}.
      </p>
    );
  }

  const message =
    freshness.state === "missing"
      ? "No herdr snapshot yet — is lh-worker running?"
      : `Herdr snapshot is stale (last updated ${formatSnapshotAge(freshness.ageMs)}) — lh-worker may be stopped.`;
  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

// Names the repos whose own `herdr agent list` capture failed on the last sweep (#2142). Without
// this, such a repo's agents were dropped from the snapshot and the page was indistinguishable
// from "nothing is running there" — the failure was invisible for as long as it lasted. Repos that
// were captured before keep showing their last known agents, marked in their own section; a repo
// never captured successfully appears only here.
function HerdrCaptureFailures({ repos }: { repos: string[] | undefined }) {
  if (!repos?.length) return null;
  return (
    <p
      role="alert"
      className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"
    >
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      Could not read the agent list for {repos.join(", ")} — those agents may be
      missing or out of date.
    </p>
  );
}

/** Absolute local time — the capture failure freezes this timestamp, so a relative age would
 * silently drift until the next snapshot change. */
function formatCaptureTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

function SessionSection({ tree }: { tree: SessionTree }) {
  return (
    <section
      data-debug-component="SessionSection"
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
        {tree.staleSince ? (
          <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            Last known agents, captured {formatCaptureTime(tree.staleSince)} —
            the agent list has not been readable since.
          </p>
        ) : null}
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
    <div
      data-debug-component="PullWorkspaceSection"
      className="flex flex-col gap-2"
    >
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
