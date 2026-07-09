import { LABEL_CHIP_BASE_CLASS } from "@/lib/label-color";
import { cn } from "@/lib/utils";

export function IssueBranchChip({
  branch,
  className,
}: {
  branch: string | null;
  className?: string;
}) {
  if (!branch) return null;
  return (
    <span
      title={`Target branch: ${branch}`}
      className={cn(
        LABEL_CHIP_BASE_CLASS,
        "border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      branch:{branch}
    </span>
  );
}
