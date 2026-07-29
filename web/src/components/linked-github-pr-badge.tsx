// Small `GH #N` pill shown next to a linked PR's `PR #N` pill once that PR has been exported to
// GitHub (#629) — renders null until then, so it never implies an export that hasn't happened.
// Shared by the issue-list linked-PR sub-row (dashboard-rows.tsx) and the issue-detail linked-PR
// row (issue-detail.tsx) so both render an identical badge. Styled like the neighbouring `PR #N`
// pill (badgeVariants), not the PR-detail sidebar's GitHub PR section heading link; opens the
// GitHub PR in a new tab.

import { Github } from "lucide-react";
import type { GithubPull } from "@/api/types";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function LinkedGithubPrBadge({
  github_pull,
}: {
  github_pull?: GithubPull | null;
}) {
  if (!github_pull) return null;
  return (
    <a
      href={github_pull.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`GitHub PR #${github_pull.number}`}
      className={cn(
        badgeVariants({ tone: "unknown" }),
        "shrink-0 gap-0.5 hover:opacity-80",
      )}
    >
      <Github className="size-3" />
      GH #{github_pull.number}
    </a>
  );
}
