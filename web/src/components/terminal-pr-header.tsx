// Top region of a Build-launched terminal tab: surfaces the PR that the running `lh dev` session
// is producing, with the PR as the star (title link) and the issue/repo/branch/worktree as quiet
// supporting detail (#270). Only Build tabs carry a `TerminalIssueRef`, so plain "+"/Home tabs
// never render this. The lookup goes issue → linked PR → PR detail, because at Build time the PR
// often does not exist yet (`lh dev` opens it mid-run); resolving via the issue is the robust path
// and lets the region fill in once the PR appears (the issue query is on the SSE invalidation map).

import { Link } from "@tanstack/react-router";
import { CopyButton } from "@/components/copy-button";
import type { TerminalIssueRef } from "@/components/terminal-controller";
import { Badge } from "@/components/ui/badge";
import { pullDetailBadges } from "@/lib/badges";
import { useIssue } from "@/queries/issues";
import { usePull } from "@/queries/pulls";

// Compact "owner/name · head-ref" tail label for the quiet supporting-detail row.
function branchAndRepo(repoFull: string, headRef: string): string {
  return `${repoFull} · ${headRef}`;
}

export function TerminalPrHeader({ issueRef }: { issueRef: TerminalIssueRef }) {
  const { owner, repo, number } = issueRef;
  const { data: issue } = useIssue(owner, repo, number);
  const prNumber = issue?.linked_pull_request?.number ?? null;

  // PR not created yet (or unresolvable): keep the region present but minimal — just the issue it
  // is building — so it never breaks while `lh dev` is still spinning up the PR.
  if (prNumber == null) {
    return (
      <HeaderShell>
        <IssueLink owner={owner} repo={repo} number={number} />
        <span className="text-muted-foreground">— waiting for PR…</span>
      </HeaderShell>
    );
  }
  return (
    <ResolvedPrHeader
      owner={owner}
      repo={repo}
      prNumber={prNumber}
      issueNumber={number}
    />
  );
}

// Split out so usePull only mounts once the PR number is known (no conditional hooks, no fetch of
// /pulls/0). Renders the full PR-centric region.
function ResolvedPrHeader({
  owner,
  repo,
  prNumber,
  issueNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  issueNumber: number;
}) {
  const { data: pr } = usePull(owner, repo, prNumber);
  const repoFull = `${owner}/${repo}`;

  // Before the PR detail lands, show the title-less skeleton row with just the PR number link so the
  // region height is stable and the link is already clickable.
  if (!pr) {
    return (
      <HeaderShell>
        <Link
          to="/r/$owner/$repo/pulls/$number"
          params={{ owner, repo, number: String(prNumber) }}
          className="font-medium text-foreground hover:underline"
        >
          PR #{prNumber}
        </Link>
      </HeaderShell>
    );
  }

  const linkedIssue = pr.linked_issue?.number ?? issueNumber;
  // Same badge composition as the PR detail page (pullDetailBadges), so the
  // terminal header status never diverges from the detail page (#386).
  const badges = pullDetailBadges(pr);

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b bg-muted/40 px-3 py-1.5 text-xs">
      {/* Row 1: the PR is the star — title as a prominent link, state badges trailing. */}
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to="/r/$owner/$repo/pulls/$number"
          params={{ owner, repo, number: String(prNumber) }}
          title={pr.title}
          className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
        >
          <span className="text-muted-foreground">#{prNumber}</span> {pr.title}
        </Link>
        {badges.length > 0 && (
          <span className="flex shrink-0 flex-wrap items-center gap-1">
            {badges.map((b, i) => (
              <Badge key={`${b.tone}-${i}`} tone={b.tone} title={b.title}>
                {b.label}
              </Badge>
            ))}
          </span>
        )}
      </div>

      {/* Row 2: supporting detail, kept quiet so it never competes with the PR title. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <IssueLink owner={owner} repo={repo} number={linkedIssue} />
        <span className="truncate" title={branchAndRepo(repoFull, pr.head.ref)}>
          {branchAndRepo(repoFull, pr.head.ref)}
        </span>
        {pr.worktree_path ? (
          <span className="flex min-w-0 items-center gap-0.5">
            <code className="truncate font-mono" title={pr.worktree_path}>
              {pr.worktree_path}
            </code>
            <CopyButton
              value={pr.worktree_path}
              label="Copy worktree path"
              className="size-5"
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function IssueLink({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  return (
    <Link
      to="/r/$owner/$repo/issues/$number"
      params={{ owner, repo, number: String(number) }}
      className="hover:text-foreground hover:underline"
    >
      issue #{number}
    </Link>
  );
}

// Single-line container matching the resolved region's chrome, for the minimal fallback states.
function HeaderShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
      {children}
    </div>
  );
}
