// Right-edge "…" menus on the issue list's issue rows and linked-PR sub-rows (#2629): the basic
// state changes (close/reopen an issue; close, archive or merge a PR) without opening the detail
// page. Each item calls the same mutation the detail page uses, and a failure goes to the toast.

import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import type { Issue, LinkedPull } from "@/api/types";
import { useToast } from "@/components/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/error-message";
import { useSetIssueState } from "@/queries/issues";
import { useArchivePull, useMergePull, useSetPullState } from "@/queries/pulls";
import { useRepoMergeMode } from "@/queries/repos";

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    // The menu content is portaled, but React still bubbles its events through this wrapper; stop
    // them here so a menu click never reaches the row's own handlers.
    <span className="flex shrink-0" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{children}</DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

export function IssueRowMenu({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const setState = useSetIssueState(owner, repo, issue.number);
  const { showError } = useToast();
  const next = issue.state === "open" ? "closed" : "open";
  return (
    <RowMenu label={`Actions for issue #${issue.number}`}>
      <DropdownMenuItem
        disabled={setState.isPending}
        onSelect={() =>
          setState.mutate(next, {
            onError: (e) => showError(errorMessage(e, "Update failed")),
          })
        }
      >
        {issue.state === "open" ? "Close" : "Reopen"}
      </DropdownMenuItem>
    </RowMenu>
  );
}

export function PullRowMenu({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
}) {
  const setState = useSetPullState(owner, repo, pull.number);
  const archive = useArchivePull(owner, repo, pull.number);
  const merge = useMergePull(owner, repo, pull.number);
  // One resolved view per repo (cached by its query key), so every PR row in the list shares it.
  const mergeMode = useRepoMergeMode(owner, repo).data?.effective;
  const { showError } = useToast();
  const canAct = pull.state === "open" && !pull.merged;
  return (
    <RowMenu label={`Actions for PR #${pull.number}`}>
      <DropdownMenuItem
        disabled={!canAct || setState.isPending}
        onSelect={() =>
          setState.mutate("closed", {
            onError: (e) => showError(errorMessage(e, "Close failed")),
          })
        }
      >
        Close
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={archive.isPending}
        onSelect={() =>
          archive.mutate(undefined, {
            onError: (e) => showError(errorMessage(e, "Archive failed")),
          })
        }
      >
        Archive
      </DropdownMenuItem>
      {/* #406: a repo in `github_pr` mode settles PRs through the GitHub export, never a local
          merge, so — as on the detail page — the row offers no Merge there. Until the mode is known
          the item stays disabled. `clean` is the detail page's merge-ready gate. */}
      {mergeMode === "github_pr" ? null : (
        <DropdownMenuItem
          disabled={
            mergeMode !== "merge" ||
            !canAct ||
            pull.mergeable_state !== "clean" ||
            merge.isPending
          }
          onSelect={() =>
            merge.mutate("squash", {
              onError: (e) => showError(errorMessage(e, "Merge failed")),
            })
          }
        >
          Merge
        </DropdownMenuItem>
      )}
    </RowMenu>
  );
}
