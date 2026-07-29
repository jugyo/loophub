import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export function DiffCommentCount({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count === 0) return null;

  return (
    <span
      aria-label={`${count} diff ${count === 1 ? "comment" : "comments"}`}
      className={cn(
        "flex shrink-0 items-center gap-1 text-muted-foreground",
        className,
      )}
    >
      <MessageSquare aria-hidden="true" className="size-3.5" />
      <span>{count}</span>
    </span>
  );
}
