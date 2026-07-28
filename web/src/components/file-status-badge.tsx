import { cn } from "@/lib/utils";

const FILE_STATUS_LABELS: Record<string, string> = {
  added: "A",
  copied: "C",
  modified: "M",
  removed: "D",
  renamed: "R",
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
        "inline-flex min-w-5 items-center justify-center rounded border bg-muted px-1 font-mono text-[10px] font-semibold uppercase text-muted-foreground",
        className,
      )}
    >
      {FILE_STATUS_LABELS[status] ?? status.slice(0, 1)}
    </span>
  );
}
