import { cn } from "@/lib/utils";

/** A labelled on/off switch. The label is the control's accessible name. */
export function Switch({
  label,
  checked,
  onCheckedChange,
  hint,
  className,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Muted text after the label — a count or other state the switch acts on. */
  hint?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-xs font-normal",
        className,
      )}
    >
      <span className="text-muted-foreground">
        {label}
        {hint ? ` ${hint}` : ""}
      </span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          checked ? "bg-primary" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "pointer-events-none block size-3 translate-y-0.5 rounded-full bg-background shadow-sm transition-transform",
            checked ? "translate-x-[14px]" : "translate-x-0.5",
          )}
        />
      </button>
    </span>
  );
}
