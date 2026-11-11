// "depending on #102 #104 · blocking #105" — the issue's dependency edges (#2644), shown next to
// its title in the issue list rows and the issue detail header.

import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleDot, Lock } from "lucide-react";
import type { Issue, IssueRefSummary } from "@/api/types";
import { cn } from "@/lib/utils";

export function IssueDependencies({
  owner,
  repo,
  issue,
  className,
}: {
  owner: string;
  repo: string;
  issue: Issue;
  className?: string;
}) {
  const blockers = issue.blocked_by ?? [];
  const blocking = issue.blocking ?? [];
  if (blockers.length === 0 && blocking.length === 0) return null;
  const blocked = blockers.some((b) => b.state === "open");
  return (
    <span
      data-debug-component="IssueDependencies"
      className={cn(
        "inline-flex shrink-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {blockers.length > 0 ? (
        <span
          data-blocked={blocked}
          className={cn(
            "inline-flex items-center gap-1",
            blocked && "text-amber-700 dark:text-amber-300",
          )}
        >
          {blocked ? <Lock aria-label="Blocked" className="size-3" /> : null}
          depending on
          {blockers.map((b) => (
            <span key={b.number} className="inline-flex items-center gap-1">
              <IssueRef owner={owner} repo={repo} issue={b} />
              {b.blocked_by.length > 0 ? (
                <span>
                  (←{" "}
                  {b.blocked_by.map((nested, index) => (
                    <span key={nested.number}>
                      {index > 0 ? " " : null}
                      <IssueRef
                        owner={owner}
                        repo={repo}
                        issue={nested}
                        icon={false}
                      />
                    </span>
                  ))}
                  )
                </span>
              ) : null}
            </span>
          ))}
        </span>
      ) : null}
      {blockers.length > 0 && blocking.length > 0 ? (
        <span aria-hidden="true">·</span>
      ) : null}
      {blocking.length > 0 ? (
        <span className="inline-flex items-center gap-1">
          blocking
          {blocking.map((b) => (
            <IssueRef key={b.number} owner={owner} repo={repo} issue={b} />
          ))}
        </span>
      ) : null}
    </span>
  );
}

function IssueRef({
  owner,
  repo,
  issue,
  icon = true,
}: {
  owner: string;
  repo: string;
  issue: IssueRefSummary;
  icon?: boolean;
}) {
  const closed = issue.state === "closed";
  const StateIcon = closed ? CircleCheck : CircleDot;
  return (
    <Link
      to="/r/$owner/$repo/issues/$number"
      params={{ owner, repo, number: String(issue.number) }}
      className="inline-flex items-center gap-0.5 hover:underline"
      title={`${issue.title} (${issue.state})`}
    >
      {icon ? <StateIcon aria-label={issue.state} className="size-3" /> : null}
      <span className={closed ? "line-through" : undefined}>
        #{issue.number}
      </span>
    </Link>
  );
}
