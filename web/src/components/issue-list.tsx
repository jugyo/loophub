// Issue list view (/r/:owner/:repo/issues). v1-parity filters (state + labels)
// over the shared list-row pattern (IssueRow). TanStack Query backed; refetches
// on SSE via the issues query key (event-keys.ts).

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { IssueRow } from "@/components/dashboard-rows";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_ISSUE_FILTERS,
  type IssueListFilters,
  useIssuesList,
} from "@/queries/issues";

const STATE_OPTIONS: { value: IssueListFilters["state"]; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export function IssueList({ owner, repo }: { owner: string; repo: string }) {
  // `filters` is what the query reads; `draft` holds unapplied input so typing
  // labels does not refetch on every keystroke (Apply commits, v1 parity).
  const [filters, setFilters] = useState<IssueListFilters>(
    DEFAULT_ISSUE_FILTERS,
  );
  const [draftLabels, setDraftLabels] = useState("");
  const query = useIssuesList(owner, repo, filters);

  function apply() {
    setFilters((f) => ({ ...f, labels: draftLabels }));
  }

  return (
    <div className="mx-auto flex max-w-content flex-col gap-4">
      <h1 className="text-2xl font-semibold">Issues</h1>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="State filter"
          value={filters.state}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              state: e.target.value as IssueListFilters["state"],
            }))
          }
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {STATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          aria-label="Labels filter"
          placeholder="Labels (comma-separated)"
          value={draftLabels}
          onChange={(e) => setDraftLabels(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
          className="h-9 min-w-48 flex-1 rounded-md border bg-background px-2 text-sm"
        />
        <Button variant="secondary" onClick={apply}>
          Apply
        </Button>
      </div>

      {query.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : query.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load.
          {query.error instanceof Error ? ` ${query.error.message}` : null}
        </div>
      ) : !query.data || query.data.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          No issues.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {query.data.map((issue) => (
            <li key={issue.number}>
              <IssueRow owner={owner} repo={repo} issue={issue} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
