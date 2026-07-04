// PR list / merged-list views (/r/:owner/:repo/pulls, .../merged). v1-parity:
// the pulls list has a state (open/closed/all) filter; the merged list is a
// fixed state=closed&merged=only query with no filter. Both reuse the shared
// PullRow. TanStack Query backed; refetches on events via the pulls query key.

import type { UseQueryResult } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { PullRequest } from "@/api/types";
import { PullRow } from "@/components/dashboard-rows";
import {
  DEFAULT_PULL_STATE,
  type PullListState,
  useMergedPullsList,
  usePullsList,
} from "@/queries/pulls";

const STATE_OPTIONS: { value: PullListState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

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

export function PullList({ owner, repo }: { owner: string; repo: string }) {
  const [state, setState] = useState<PullListState>(DEFAULT_PULL_STATE);
  const query = usePullsList(owner, repo, state);

  return (
    <div className="mx-auto flex max-w-content flex-col gap-4">
      <h1 className="text-2xl font-semibold">Pull requests</h1>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="State filter"
          value={state}
          onChange={(e) => setState(e.target.value as PullListState)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {STATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <PullListBody
        owner={owner}
        repo={repo}
        query={query}
        emptyText="No pull requests."
      />
    </div>
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
