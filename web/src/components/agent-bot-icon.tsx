import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

export function AgentBotIcon({
  working = false,
  needsAttention = false,
  inactive = false,
  label,
  className,
}: {
  working?: boolean;
  needsAttention?: boolean;
  inactive?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-agent-bot-icon
      role={label ? "img" : undefined}
      aria-label={label}
      className={cn(
        "relative flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
        working &&
          "animate-agent-bot-blink bg-indigo-100 text-indigo-700 ring-1 ring-indigo-500/70 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-300/80",
        inactive && "opacity-45",
        className,
      )}
    >
      <Bot className="size-3" aria-hidden="true" />
      {needsAttention ? (
        <span
          data-agent-bot-attention
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-[1.5px] border-background bg-destructive"
        />
      ) : null}
    </span>
  );
}
