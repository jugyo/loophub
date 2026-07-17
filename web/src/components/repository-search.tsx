import { useNavigate } from "@tanstack/react-router";
import { CircleDot, GitPullRequest, Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { useRepositorySearch } from "@/queries/search";

export function RepositorySearch({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [includePulls, setIncludePulls] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useRepositorySearch(owner, repo, query);
  const term = query.trim();
  const results = (search.data ?? []).filter(
    (result) => includePulls || result.kind === "issue",
  );

  useEffect(() => {
    if (!open) return;
    const focusFrame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    focusFrame(() => inputRef.current?.focus());
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
    setIncludePulls(false);
  }

  function select(result: SearchResult) {
    close();
    navigate({
      to:
        result.kind === "issue"
          ? "/r/$owner/$repo/issues/$number"
          : "/r/$owner/$repo/pulls/$number",
      params: { owner, repo, number: String(result.number) },
    });
  }

  return (
    <>
      <div className="flex justify-end">
        <button
          type="button"
          aria-label="Search issues"
          onClick={() => setOpen(true)}
          className="flex w-56 items-center gap-3 rounded-md border bg-background px-3 py-2.5 text-left text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Search className="size-4" aria-hidden="true" />
          <span className="truncate">Search issues</span>
        </button>
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 px-4 pt-24"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search repository"
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
            className="flex w-full max-w-2xl flex-col overflow-hidden rounded-md border bg-background shadow-lg outline-none ring-1 ring-border"
          >
            <div className="flex h-12 items-center gap-2 border-b px-3">
              <Search
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                ref={inputRef}
                type="search"
                aria-label="Search query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                aria-label="Close repository search"
                onClick={close}
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex items-center justify-end border-b px-3 py-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <span>Include PR</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={includePulls}
                  onClick={() => setIncludePulls((current) => !current)}
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    includePulls ? "bg-primary" : "bg-muted"
                  }`}
                >
                  <span
                    className={`pointer-events-none block size-4 translate-y-0.5 rounded-full bg-background shadow-sm transition-transform ${
                      includePulls ? "translate-x-[18px]" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </label>
            </div>

            <SearchResults
              term={term}
              results={results}
              loading={search.isLoading && term.length > 0}
              failed={search.isError}
              includePulls={includePulls}
              onSelect={select}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function SearchResults({
  term,
  results,
  loading,
  failed,
  includePulls,
  onSelect,
}: {
  term: string;
  results: SearchResult[];
  loading: boolean;
  failed: boolean;
  includePulls: boolean;
  onSelect: (result: SearchResult) => void;
}) {
  if (!term) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Enter a search term.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Searching…
      </div>
    );
  }
  if (failed) {
    return (
      <div role="alert" className="p-4 text-sm text-destructive">
        Search failed.
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {includePulls
          ? "No matching issues or pull requests."
          : "No matching issues."}
      </div>
    );
  }
  return (
    <ul aria-label="Search results" className="max-h-96 overflow-y-auto p-1">
      {results.map((result) => {
        const isIssue = result.kind === "issue";
        return (
          <li key={`${result.kind}-${result.number}`}>
            <button
              type="button"
              onClick={() => onSelect(result)}
              className="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {isIssue ? (
                <CircleDot
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <GitPullRequest
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {result.title}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {isIssue ? "Issue" : "Pull request"} #{result.number}
                </span>
              </span>
              <Badge tone={result.state}>{result.state}</Badge>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
