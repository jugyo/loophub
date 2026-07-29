import { cn } from "@/lib/utils";

const FILE_STATUS_LABELS: Record<string, string> = {
  added: "A",
  copied: "C",
  modified: "M",
  removed: "D",
  renamed: "R",
};

const FILE_STATUS_CLASSES: Record<string, string> = {
  added:
    "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300",
  copied:
    "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-300",
  modified:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  removed:
    "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300",
  renamed:
    "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
};

export function FileStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      title={status}
      aria-label={`File status: ${status}`}
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded border px-1 font-mono text-[10px] font-semibold uppercase",
        FILE_STATUS_CLASSES[status] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {FILE_STATUS_LABELS[status] ?? status.slice(0, 1)}
    </span>
  );
}
