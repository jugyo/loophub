// PR-detail Commits section: the PR's commit history newest first, each row opening a dialog with
// that commit's diff. Commit selection, the per-commit diff query, the dialog's dismissal, and the
// GitHub push badge all stay inside; the PR detail only places the section and says whether push
// state is meaningful (i.e. the PR has a linked GitHub PR).

import { Loader2, UploadCloud, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PullRequest } from "@/api/types";
import { DiffLines } from "@/components/diff-lines";
import { DiffStat } from "@/components/diff-stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/time";
import { usePullCommitFiles } from "@/queries/pulls";

type PullCommit = NonNullable<PullRequest["commits"]>[number];

export function PullCommitsSection({
  owner,
  repo,
  number,
  commits = [],
  showGithubPushState,
}: {
  owner: string;
  repo: string;
  number: number;
  commits: PullRequest["commits"];
  showGithubPushState: boolean;
}) {
  const [selectedCommit, setSelectedCommit] = useState<PullCommit | null>(null);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Commits ({commits.length})</h2>
      {commits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commits.</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-md border">
          {commits.map((commit) => (
            <li key={commit.sha}>
              <button
                type="button"
                aria-label={`View changes in ${commit.sha.slice(0, 7)}: ${commit.subject}`}
                className="flex w-full min-w-0 items-start gap-3 px-3 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => setSelectedCommit(commit)}
              >
                <code className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 text-xs">
                  {commit.sha.slice(0, 7)}
                </code>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {commit.subject}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {commit.author} ·{" "}
                    <time dateTime={commit.date} title={commit.date}>
                      {relativeTime(commit.date)}
                    </time>
                  </div>
                </div>
                {showGithubPushState && commit.pushed_to_github ? (
                  <Badge
                    tone="unknown"
                    title="Pushed to GitHub"
                    className="mt-0.5 shrink-0 gap-1"
                  >
                    <UploadCloud className="size-3" />
                    Pushed
                  </Badge>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedCommit ? (
        <CommitDiffDialog
          owner={owner}
          repo={repo}
          number={number}
          commit={selectedCommit}
          onClose={() => setSelectedCommit(null)}
        />
      ) : null}
    </section>
  );
}

function CommitDiffDialog({
  owner,
  repo,
  number,
  commit,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  commit: PullCommit;
  onClose: () => void;
}) {
  const filesQuery = usePullCommitFiles(owner, repo, number, commit.sha);
  const shortSha = commit.sha.slice(0, 7);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/80 p-2 backdrop-blur-sm sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Changes in ${shortSha}: ${commit.subject}`}
        className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      >
        <header className="flex items-start justify-between gap-3 border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-xs">
              {shortSha}
            </code>
            <h3 className="truncate text-sm font-semibold">{commit.subject}</h3>
          </div>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Close commit diff"
            className="h-7 w-7 shrink-0 p-0"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {filesQuery.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading commit diff…
            </div>
          ) : filesQuery.isError ? (
            <div className="m-4 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              Failed to load commit diff.
              {filesQuery.error instanceof Error
                ? ` ${filesQuery.error.message}`
                : null}
            </div>
          ) : !filesQuery.data || filesQuery.data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No changes in this commit.
            </p>
          ) : (
            <div className="flex flex-col gap-3 p-3">
              {filesQuery.data.map((file) => (
                <article
                  key={file.filename}
                  className="overflow-hidden rounded-md border"
                >
                  <header className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {file.filename}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {file.status}
                      </div>
                    </div>
                    <DiffStat
                      additions={file.additions}
                      deletions={file.deletions}
                      className="text-xs"
                    />
                  </header>
                  <div className="border-t">
                    <DiffLines patch={file.patch} />
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
