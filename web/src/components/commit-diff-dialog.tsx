import { Loader2, X } from "lucide-react";
import { useEffect } from "react";
import { DiffLines } from "@/components/diff-lines";
import { DiffStat } from "@/components/diff-stat";
import { Button } from "@/components/ui/button";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { useCommitFiles } from "@/queries/pulls";

export function CommitDiffDialog({
  owner,
  repo,
  sha,
  subject,
  onClose,
}: {
  owner: string;
  repo: string;
  sha: string;
  subject: string;
  onClose: () => void;
}) {
  const filesQuery = useCommitFiles(owner, repo, sha);
  const shortSha = sha.slice(0, 7);
  const backdropDismiss = useBackdropDismiss(onClose);

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
      {...backdropDismiss}
    >
      <div
        data-debug-component="CommitDiffDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Changes in ${shortSha}: ${subject}`}
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
                  data-debug-component="CommitDiffFile"
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
