// The repository top page's right sidebar (#71). It holds one section today: where the registered
// checkout stands against its `origin` remote, and the Pull that brings it up to date. A repo
// without an origin has nothing to sync, so the section says so rather than offering counts and a
// button that could only fail.

import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  GitBranch,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import { usePullRepoFromOrigin, useRepoOriginSync } from "@/queries/repos";

export function RepoSidebar({ owner, repo }: { owner: string; repo: string }) {
  return (
    <aside
      data-debug-component="RepoSidebar"
      className="flex w-full shrink-0 flex-col gap-6 lg:w-64"
    >
      <OriginSection owner={owner} repo={repo} />
    </aside>
  );
}

// ahead / behind as a compact arrow pair: `↑2` counts commits the checkout has and origin does not,
// `↓1` the reverse. Null counts mean there is no `origin/<branch>` to compare against yet (the
// branch was never pushed), which is not the same as 0/0 — showing zeros there would read as
// "in sync with origin".
function AheadBehind({
  ahead,
  behind,
}: {
  ahead: number | null;
  behind: number | null;
}) {
  if (ahead === null || behind === null) {
    return (
      <span className="text-xs text-muted-foreground">not on origin yet</span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs tabular-nums">
      <span
        className="flex items-center gap-0.5"
        aria-label={`${ahead} ahead of origin`}
      >
        <ArrowUp className="size-3.5" aria-hidden="true" />
        {ahead}
      </span>
      <span
        className="flex items-center gap-0.5"
        aria-label={`${behind} behind origin`}
      >
        <ArrowDown className="size-3.5" aria-hidden="true" />
        {behind}
      </span>
    </span>
  );
}

function OriginSection({ owner, repo }: { owner: string; repo: string }) {
  const query = useRepoOriginSync(owner, repo);
  const pull = usePullRepoFromOrigin(owner, repo);
  // A failed background refetch keeps the last-loaded value, so the sync branch below stays on
  // real data instead of blanking; only a load that never produced one falls through to the error.
  const sync = query.data;

  return (
    <section
      data-debug-component="RepoOriginSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">Origin</h2>
      {query.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading origin status…
        </div>
      ) : !sync ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          Failed to load origin status.
        </div>
      ) : !sync.has_origin ? (
        <p className="text-sm text-muted-foreground">No origin remote.</p>
      ) : (
        <>
          {/* The counts follow the branch name rather than being pushed to the sidebar's far edge:
              they are a fact about that branch, and a gap the width of the column reads as two
              unrelated items. A long branch name truncates instead of crowding them out. */}
          <div className="flex items-center gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-1.5">
              <GitBranch
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate font-mono text-xs">
                {sync.branch ?? "detached HEAD"}
              </span>
            </span>
            {sync.branch ? (
              <span className="shrink-0">
                <AheadBehind ahead={sync.ahead} behind={sync.behind} />
              </span>
            ) : null}
          </div>
          {/* Sized to its own label rather than the sidebar's width: a full-width primary block
              reads as the page's main action, which this is not — the issue list's New issue is.
              Fast-forward only, so a diverged branch fails with git's own message instead of
              writing a merge commit into the checkout. Disabled on a detached HEAD: there is no
              branch to pull into. */}
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() => pull.mutate()}
            disabled={pull.isPending || !sync.branch}
            title={
              sync.branch
                ? `git pull --ff-only origin ${sync.branch}`
                : "HEAD is detached"
            }
          >
            {pull.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowDownToLine className="size-3.5" aria-hidden="true" />
            )}
            Pull
          </Button>
          {/* git's message carries repository paths, which have no spaces to wrap at and would
              otherwise run past the sidebar's edge. */}
          {pull.isError ? (
            <div
              role="alert"
              className="break-words rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {errorMessage(pull.error, "Pull failed")}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
