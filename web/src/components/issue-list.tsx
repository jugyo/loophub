// Repo top issue list (/r/:owner/:repo). State tabs + label filters over the
// shared list-row pattern (IssueRow). TanStack Query backed; refetches on
// events via the issues query key (event-keys.ts).

import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CreateIssueButton } from "@/components/create-issue-button";
import { IssueRow } from "@/components/dashboard-rows";
import { RepoHerdrCommand } from "@/components/repo-herdr-command";
import { Button } from "@/components/ui/button";
import { LABEL_CHIP_BASE_CLASS, labelColorClass } from "@/lib/label-color";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ISSUE_FILTERS,
  ISSUE_LIST_PAGE_SIZE,
  type IssueListFilters,
  useIssuesList,
  useLabelsList,
} from "@/queries/issues";

const STATE_TABS: {
  value: IssueListFilters["state"];
  label: string;
}[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

function parseLabelsParam(labels: string): string[] {
  return labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function labelsParamFromList(labels: string[]): string | undefined {
  return labels.length > 0 ? labels.join(",") : undefined;
}

export function IssueList({
  owner,
  repo,
  labelsParam,
  stateParam,
  labelFilterMode = "text",
}: {
  owner: string;
  repo: string;
  /** `labels` search param — seeds the filter so a label chip can deep-link here pre-filtered (#368). */
  labelsParam?: string;
  /** `state` search param — omitted for open, `closed` or `all` for the other tabs. */
  stateParam?: IssueListFilters["state"];
  /** Repo top uses the dropdown requested in #884; secondary issue lists keep the legacy text filter. */
  labelFilterMode?: "text" | "select";
}) {
  const labels = labelsParam ?? "";
  const state = stateParam ?? DEFAULT_ISSUE_FILTERS.state;
  const filters = useMemo<IssueListFilters>(
    () => ({
      ...DEFAULT_ISSUE_FILTERS,
      state,
      labels,
    }),
    [state, labels],
  );
  const [draftLabels, setDraftLabels] = useState(labelsParam ?? "");
  const query = useIssuesList(owner, repo, filters);
  const labelsQuery = useLabelsList(owner, repo, labelFilterMode === "select");
  const navigate = useNavigate();
  const visibleIssues = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return pages.flatMap((page) => page.slice(0, ISSUE_LIST_PAGE_SIZE));
  }, [query.data]);

  // The `labels` URL param is the single source of truth for the labels filter,
  // so a label chip elsewhere and the Apply button below agree and the filtered
  // list is shareable/bookmarkable. This effect mirrors the param into the live
  // filter and the input draft whenever it changes (chip click on this same
  // page, back/forward, reload).
  useEffect(() => {
    setDraftLabels(labels);
  }, [labels]);

  // Apply commits the draft to the URL (not directly to state) — the effect
  // above then applies it. Keeps the URL authoritative so a reload/share keeps
  // the same filter; an empty box drops the param entirely.
  function apply() {
    navigate({
      to: "/r/$owner/$repo",
      params: { owner, repo },
      search: {
        labels: draftLabels.trim() || undefined,
        state: state === "open" ? undefined : state,
      },
    });
  }

  const selectedLabels = useMemo(() => parseLabelsParam(labels), [labels]);

  function navigateWithLabels(nextLabels: string[]) {
    navigate({
      to: "/r/$owner/$repo",
      params: { owner, repo },
      search: {
        labels: labelsParamFromList(nextLabels),
        state: state === "open" ? undefined : state,
      },
    });
  }

  function addSelectedLabel(nextLabel: string) {
    if (!nextLabel || selectedLabels.includes(nextLabel)) return;
    navigateWithLabels([...selectedLabels, nextLabel]);
  }

  function removeSelectedLabel(labelToRemove: string) {
    navigateWithLabels(
      selectedLabels.filter((label) => label !== labelToRemove),
    );
  }

  const labelOptions = labelsQuery.data ?? [];
  const availableLabelOptions = labelOptions.filter(
    (label) => !selectedLabels.includes(label.name),
  );

  return (
    <div className="mx-auto flex max-w-content flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">
          {owner}/{repo}
        </h1>
        <RepoHerdrCommand owner={owner} repo={repo} />
        <p className="text-sm text-muted-foreground">Issues</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Issue state"
          className="flex h-9 shrink-0 items-center rounded-md border bg-muted p-1"
        >
          {STATE_TABS.map((tab) => {
            const active = state === tab.value;
            return (
              <Link
                key={tab.value}
                role="tab"
                aria-selected={active}
                to="/r/$owner/$repo"
                params={{ owner, repo }}
                search={{
                  labels: labels || undefined,
                  state: tab.value === "open" ? undefined : tab.value,
                }}
                className={
                  active
                    ? "rounded-sm bg-accent px-3 py-1 text-sm font-medium text-accent-foreground shadow-sm"
                    : "rounded-sm px-3 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        {labelFilterMode === "select" ? (
          <div className="flex min-h-9 min-w-64 flex-1 flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1">
            {selectedLabels.length > 0 ? (
              <div
                aria-label="Selected labels"
                className="flex min-w-0 flex-wrap items-center gap-1"
              >
                {selectedLabels.map((label) => (
                  <span
                    key={label}
                    className={cn(
                      LABEL_CHIP_BASE_CLASS,
                      labelColorClass(label),
                      "h-6 max-w-48 gap-1 pr-1",
                    )}
                  >
                    <span className="truncate">{label}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${label} label filter`}
                      onClick={() => removeSelectedLabel(label)}
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/15"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <select
              aria-label="Label filter"
              value=""
              onChange={(e) => addSelectedLabel(e.target.value)}
              className="h-7 min-w-32 flex-1 border-0 bg-transparent px-1 text-sm outline-none"
            >
              <option value="">
                {selectedLabels.length > 0 ? "Add label" : "All labels"}
              </option>
              {availableLabelOptions.map((label) => (
                <option key={label.name} value={label.name}>
                  {label.name}
                </option>
              ))}
            </select>
            {selectedLabels.length > 0 ? (
              <button
                type="button"
                aria-label="Clear label filters"
                onClick={() => navigateWithLabels([])}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        ) : (
          <>
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
          </>
        )}
        <CreateIssueButton repo={`${owner}/${repo}`} />
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
      ) : visibleIssues.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          {state === "closed"
            ? "No closed issues."
            : state === "all"
              ? "No issues."
              : "No open issues."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y rounded-md border">
            {visibleIssues.map((issue) => (
              <li key={issue.number}>
                <IssueRow
                  owner={owner}
                  repo={repo}
                  issue={issue}
                  labelState={state}
                />
              </li>
            ))}
          </ul>
          {query.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : null}
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
