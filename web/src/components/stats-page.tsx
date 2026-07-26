// Database statistics page (#587) — a read-only snapshot of the DB fetched via
// `stats/get` on page load: per-table row counts, the SQLite file's on-disk size
// (WAL included), and per-repo issue/PR tallies. All aggregation happens in core;
// this page only renders the numbers.

import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { Stats } from "@/api/types";
import { StatsHeader } from "@/components/stats-header";
import { useStats } from "@/queries/stats";

/** 1234 -> "1.2 KB". Binary units, one decimal below 100, none at/above. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // Promote once more when rounding would land on 1024 ("1024 KB" -> "1.0 MB").
  if (Math.round(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // 99.95 is toFixed(1)'s carry threshold: below it one decimal, at/above a
  // whole number — so "100.0" can never appear.
  return `${v >= 99.95 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function DatabaseStatsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useStats();

  return (
    <div
      data-debug-component="DatabaseStatsPage"
      className="flex w-full flex-col"
    >
      <StatsHeader
        activeTab="db"
        onTabChange={(tab) => {
          if (tab === "cost") void navigate({ to: "/stats" });
        }}
        panelIds={{ db: "stats-db-panel" }}
      />

      <div id="stats-db-panel" role="tabpanel" aria-labelledby="stats-db-tab">
        <p className="mt-6 text-sm text-muted-foreground">
          Database statistics for this LoopHub server.
        </p>

        {isLoading && (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        {isError && (
          <div className="mt-6 text-sm text-destructive">
            Failed to load stats.
          </div>
        )}

        {data && (
          <>
            <DatabaseSection database={data.database} />
            <TablesSection tables={data.tables} />
            <ReposSection repos={data.repos} />
          </>
        )}
      </div>
    </div>
  );
}

function DatabaseSection({ database }: { database: Stats["database"] }) {
  return (
    <section data-debug-component="DatabaseSection" className="mt-6">
      <h2 className="text-sm font-medium">Database file</h2>
      <p
        className="mt-1 truncate text-sm text-muted-foreground"
        title={database.path}
      >
        <code>{database.path}</code>
      </p>
      <dl className="mt-3 max-w-md rounded-md border text-sm">
        <SizeRow label="Database" bytes={database.size_bytes} />
        <SizeRow label="WAL" bytes={database.wal_size_bytes} fallback="none" />
        <SizeRow label="Total" bytes={database.total_size_bytes} />
      </dl>
    </section>
  );
}

function SizeRow({
  label,
  bytes,
  fallback,
}: {
  label: string;
  bytes: number | null;
  fallback?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b px-3 py-2 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {bytes === null ? fallback : formatBytes(bytes)}
      </dd>
    </div>
  );
}

function TablesSection({ tables }: { tables: Stats["tables"] }) {
  return (
    <section data-debug-component="TablesSection" className="mt-6">
      <h2 className="text-sm font-medium">Tables</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Row counts for every table.
      </p>
      <table className="mt-3 w-full max-w-md text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Table</th>
            <th className="px-3 py-2 text-right font-medium">Rows</th>
          </tr>
        </thead>
        <tbody>
          {tables.map((t) => (
            <tr key={t.name} className="border-b last:border-b-0">
              <td className="px-3 py-1.5">
                <code>{t.name}</code>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {t.rows.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ReposSection({ repos }: { repos: Stats["repos"] }) {
  return (
    <section data-debug-component="ReposSection" className="mt-6">
      <h2 className="text-sm font-medium">Repositories</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Issue and pull request counts per repository.
      </p>
      {repos.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No repositories.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Repository</th>
              <th className="px-3 py-2 text-right font-medium">Issues open</th>
              <th className="px-3 py-2 text-right font-medium">
                Issues closed
              </th>
              <th className="px-3 py-2 text-right font-medium">PRs open</th>
              <th className="px-3 py-2 text-right font-medium">PRs merged</th>
              <th className="px-3 py-2 text-right font-medium">PRs closed</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((r) => (
              <tr key={r.full_name} className="border-b last:border-b-0">
                <td className="break-all px-3 py-1.5">{r.full_name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.issues.open.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.issues.closed.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.pulls.open.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.pulls.merged.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.pulls.closed.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
