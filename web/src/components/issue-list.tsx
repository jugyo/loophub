// Issue list view (/r/:owner/:repo/issues). v1-parity filters (state + labels)
// over the shared list-row pattern (IssueRow). TanStack Query backed; refetches
// on SSE via the issues query key (event-keys.ts).

import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
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

export function IssueList({
  owner,
  repo,
  labelsParam,
  stateParam,
}: {
  owner: string;
  repo: string;
  /** `labels` search param — seeds the filter so a label chip can deep-link here pre-filtered (#368). */
  labelsParam?: string;
  /** `state` search param — seeds the state filter so the repo dashboard can deep-link to closed issues (#616). */
  stateParam?: IssueListFilters["state"];
}) {
  // `filters` is what the query reads; `draft` holds unapplied input so typing
  // labels does not refetch on every keystroke (Apply commits, v1 parity). The
  // `state` search param only seeds the initial filter; the select below then
  // owns it (out of scope: keeping state URL-authoritative like labels).
  const [filters, setFilters] = useState<IssueListFilters>({
    ...DEFAULT_ISSUE_FILTERS,
    state: stateParam ?? DEFAULT_ISSUE_FILTERS.state,
    labels: labelsParam ?? "",
  });
  const [draftLabels, setDraftLabels] = useState(labelsParam ?? "");
  const query = useIssuesList(owner, repo, filters);
  const navigate = useNavigate();

  // The `labels` URL param is the single source of truth for the labels filter,
  // so a label chip elsewhere and the Apply button below agree and the filtered
  // list is shareable/bookmarkable. This effect mirrors the param into the live
  // filter and the input draft whenever it changes (chip click on this same
  // page, back/forward, reload).
  useEffect(() => {
    const next = labelsParam ?? "";
    setFilters((f) => ({ ...f, labels: next }));
    setDraftLabels(next);
  }, [labelsParam]);

  // Apply commits the draft to the URL (not directly to state) — the effect
  // above then applies it. Keeps the URL authoritative so a reload/share keeps
  // the same filter; an empty box drops the param entirely.
  function apply() {
    navigate({
      to: "/r/$owner/$repo/issues",
      params: { owner, repo },
      search: { labels: draftLabels.trim() || undefined },
    });
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
