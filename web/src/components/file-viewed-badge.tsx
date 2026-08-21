import { Check } from "lucide-react";
import type { PullFileViewState } from "@/lib/pull-file-views";
import { cn } from "@/lib/utils";

/**
 * Marks a changed file's standing against the viewed record (#2502). A viewed file only shows this
 * while the "Show viewed" toggle is on, so it stays quiet; a file that moved on since it was marked
 * is back in the default list and says why.
 */
export function FileViewedBadge({
  state,
  className,
}: {
  state: PullFileViewState;
  className?: string;
}) {
  if (state === "unviewed") return null;
  if (state === "viewed") {
    return (
      <span
        title="Viewed"
        aria-label="Viewed"
        className={cn(
          "inline-flex items-center gap-0.5 whitespace-nowrap text-[10px] text-muted-foreground",
          className,
        )}
      >
        <Check className="size-3" />
        Viewed
      </span>
    );
  }
  return (
    <span
      title="Changed since you marked this file viewed"
      aria-label="Changed since viewed"
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1 text-[10px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
        className,
      )}
    >
      New changes
    </span>
  );
}
