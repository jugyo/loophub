// GitHub-style diff total: +additions in green, −deletions in red. Used in the
// PR detail "Files changed" header and the PR list rows. Colors are tuned for
// both light and dark themes; numbers are tabular so columns stay aligned.

export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono tabular-nums ${className ?? ""}`}
    >
      <span className="text-green-600 dark:text-green-400">+{additions}</span>
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  );
}
