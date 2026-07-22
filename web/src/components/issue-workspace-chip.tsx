import { LABEL_CHIP_BASE_CLASS } from "@/lib/label-color";
import { cn } from "@/lib/utils";

export function IssueWorkspaceChip({
  workspace,
  className,
}: {
  workspace: string | null;
  className?: string;
}) {
  if (!workspace) return null;
  return (
    <span
      title={`Workspace: ${workspace}`}
      className={cn(
        LABEL_CHIP_BASE_CLASS,
        "rounded-md border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      workspace:{workspace}
    </span>
  );
}
