// Generic dashboard section frame: heading with an optional headerAction slot,
// TanStack Query state handling (loading / error / empty / list), and an
// optional "see all" link below the list. Each repo dashboard section (Open
// PRs, Open Issues, etc.) renders through this.

import type { UseQueryResult } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function DashboardSection<T>({
  title,
  query,
  seeAllTo,
  seeAllParams,
  emptyText,
  renderItem,
  keyOf,
  headerAction,
  footerNote,
}: {
  title: string;
  query: UseQueryResult<T[]>;
  /** Route to the dedicated list view; omitted sections have no "see all". */
  seeAllTo?: LinkProps["to"];
  seeAllParams?: LinkProps["params"];
  emptyText: string;
  renderItem: (item: T) => ReactNode;
  keyOf: (item: T) => string | number;
  /** Rendered to the right of the title in the section header. */
  headerAction?: ReactNode;
  /** Subtle muted text below the list, e.g. a note that the list is capped. */
  footerNote?: ReactNode;
}) {
  const { data, isLoading, isError, error } = query;

  return (
    <section
      data-debug-component="DashboardSection"
      className="flex flex-col gap-2"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {headerAction}
      </header>

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load.
          {error instanceof Error ? ` ${error.message}` : null}
        </div>
      ) : !data || data.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {data.map((item) => (
            <li key={keyOf(item)}>{renderItem(item)}</li>
          ))}
        </ul>
      )}

      {footerNote ? (
        <p className="self-end text-xs text-muted-foreground">{footerNote}</p>
      ) : null}

      {seeAllTo ? (
        <Link
          to={seeAllTo}
          params={seeAllParams}
          className="self-end text-xs text-muted-foreground hover:text-foreground"
        >
          See all
        </Link>
      ) : null}
    </section>
  );
}
