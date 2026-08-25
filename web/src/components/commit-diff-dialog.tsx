import { Loader2, X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import type { PullDiff, PullFile } from "@/api/types";
import {
  type DiffDialogSource,
  DiffFileDialog,
} from "@/components/pull-diff-dialog";
import { Button } from "@/components/ui/button";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { useCommitDiff, useDiffFeedback } from "@/queries/pulls";

function commitFiles(diff: PullDiff): PullFile[] {
  return diff.files.map((file) => ({
    filename: file.path,
    previousFilename: file.original_path ?? undefined,
    headFilename: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
    syntax_highlight: file.syntax_highlight,
  }));
}

export function CommitDiffDialog({
  owner,
  repo,
  number,
  sha,
  subject,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  sha: string;
  subject: string;
  onClose: () => void;
}) {
  const diffQuery = useCommitDiff(owner, repo, sha);
  const shortSha = sha.slice(0, 7);
  const label = `Changes in ${shortSha}: ${subject}`;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const diff = diffQuery.data;
  const feedback = useDiffFeedback(
    owner,
    repo,
    number,
    diff
      ? { base_sha: diff.base_sha, head_sha: diff.head_sha }
      : { base_sha: undefined, head_sha: undefined },
    Boolean(diff),
  );

  if (diffQuery.isLoading) {
    return (
      <CommitStateDialog
        label={label}
        shortSha={shortSha}
        subject={subject}
        onClose={onClose}
      >
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading commit diff…
        </div>
      </CommitStateDialog>
    );
  }
  if (diffQuery.isError) {
    return (
      <CommitStateDialog
        label={label}
        shortSha={shortSha}
        subject={subject}
        onClose={onClose}
      >
        <div className="m-4 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load commit diff.
          {diffQuery.error instanceof Error
            ? ` ${diffQuery.error.message}`
            : null}
        </div>
      </CommitStateDialog>
    );
  }

  const files = diff ? commitFiles(diff) : [];
  if (!diff || files.length === 0) {
    return (
      <CommitStateDialog
        label={label}
        shortSha={shortSha}
        subject={subject}
        onClose={onClose}
      >
        <p className="p-4 text-sm text-muted-foreground">
          No changes in this commit.
        </p>
      </CommitStateDialog>
    );
  }

  const source: DiffDialogSource = {
    kind: "commit",
    sha,
    baseSha: diff.base_sha,
    headSha: diff.head_sha,
  };
  return (
    <DiffFileDialog
      owner={owner}
      repo={repo}
      number={number}
      files={files}
      file={files[0]}
      source={source}
      dialogLabel={label}
      dialogTitle={subject}
      dialogSha={shortSha}
      commentCounts={feedback.data?.comment_counts}
      onSelectFile={() => {}}
      onClose={onClose}
    />
  );
}

function CommitStateDialog({
  label,
  shortSha,
  subject,
  onClose,
  children,
}: {
  label: string;
  shortSha: string;
  subject: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const backdropDismiss = useBackdropDismiss(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/80 p-2 backdrop-blur-sm sm:p-4"
      {...backdropDismiss}
    >
      <div
        data-debug-component="CommitDiffDialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      >
        <header className="flex items-start justify-between gap-3 border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-xs">
              {shortSha}
            </code>
            <h3 className="truncate text-sm font-semibold">{subject}</h3>
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
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
