import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import type { PullDiff, PullFile } from "@/api/types";
import {
  type DiffDialogSource,
  DiffDialogState,
  DiffFileDialog,
} from "@/components/pull-diff-dialog";
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
      <DiffDialogState
        dialogLabel={label}
        dialogSha={shortSha}
        dialogTitle={subject}
        onClose={onClose}
      >
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading commit diff…
        </div>
      </DiffDialogState>
    );
  }
  if (diffQuery.isError) {
    return (
      <DiffDialogState
        dialogLabel={label}
        dialogSha={shortSha}
        dialogTitle={subject}
        onClose={onClose}
      >
        <div className="m-4 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load commit diff.
          {diffQuery.error instanceof Error
            ? ` ${diffQuery.error.message}`
            : null}
        </div>
      </DiffDialogState>
    );
  }

  const files = diff ? commitFiles(diff) : [];
  if (!diff || files.length === 0) {
    return (
      <DiffDialogState
        dialogLabel={label}
        dialogSha={shortSha}
        dialogTitle={subject}
        onClose={onClose}
      >
        <p className="p-4 text-sm text-muted-foreground">
          No changes in this commit.
        </p>
      </DiffDialogState>
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
