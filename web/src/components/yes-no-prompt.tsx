// A compact inline yes/no question: one sentence and two buttons, sized to sit in a list row next
// to other row metadata. The widget owns no decision — the caller supplies the question and what
// each answer does — so any "should I do X?" moment can render one instead of its own ad-hoc button.

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function YesNoPrompt({
  question,
  onYes,
  onNo,
  pending = false,
  className,
}: {
  /** The whole question, shown as written. Also names the group for assistive technology. */
  question: string;
  onYes: () => void;
  onNo: () => void;
  /** Disable both answers while the yes action is in flight. */
  pending?: boolean;
  className?: string;
}) {
  return (
    <span
      data-debug-component="YesNoPrompt"
      role="group"
      aria-label={question}
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <span className="text-foreground">{question}</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-6 gap-1 px-2 text-xs font-normal"
        disabled={pending}
        onClick={onYes}
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : null}
        Yes
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs font-normal"
        disabled={pending}
        onClick={onNo}
      >
        No
      </Button>
    </span>
  );
}
