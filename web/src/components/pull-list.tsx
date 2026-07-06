// Merged PR list view (/r/:owner/:repo/merged). The regular PR list route was
// removed; PR detail remains reachable from issue-linked PR rows.

import type { UseQueryResult } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { PullRequest } from "@/api/types";
import { PullRow } from "@/components/dashboard-rows";
import { useMergedPullsList } from "@/queries/pulls";

function PullListBody({
  owner,
  repo,
  query,
  emptyText,
}: {
  owner: string;
  repo: string;
  query: UseQueryResult<PullRequest[]>;
  emptyText: string;
}) {
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load.
        {query.error instanceof Error ? ` ${query.error.message}` : null}
      </div>
    );
  }
  if (!query.data || query.data.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {query.data.map((pull) => (
        <li key={pull.number}>
          <PullRow owner={owner} repo={repo} pull={pull} />
        </li>
      ))}
    </ul>
  );
}

export function MergedList({ owner, repo }: { owner: string; repo: string }) {
  const query = useMergedPullsList(owner, repo);

  return (
    <div className="mx-auto flex max-w-content flex-col gap-4">
      <h1 className="text-2xl font-semibold">Merged pull requests</h1>
      <PullListBody
        owner={owner}
        repo={repo}
        query={query}
        emptyText="No merged pull requests yet."
      />
    </div>
  );
}
