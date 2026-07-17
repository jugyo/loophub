// Status badge pill. Neutral/destructive/success tones stay semantic; active work states use the
// shared primary theme tokens so badges align with the rest of the UI chrome.

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
  {
    variants: {
      tone: {
        open: "border-primary-border bg-primary-subtle text-link",
        closed: "border-border text-muted-foreground",
        draft:
          "border-border bg-muted text-muted-foreground dark:text-muted-foreground",
        merged: "border-purple-600/60 text-purple-500 dark:text-purple-400",
        "review-passed":
          "border-green-600/60 text-green-600 dark:text-green-400",
        "review-changes": "border-destructive/50 text-destructive",
        "review-rereview":
          "border-amber-500/60 text-amber-600 dark:text-amber-400",
        "review-commented": "border-border text-muted-foreground",
        mergeable: "border-primary-border bg-primary-subtle text-link",
        conflict: "border-destructive/50 text-destructive",
        working: "border-primary-border bg-primary-subtle text-link",
        // #863: a PR whose dev agent was force-stopped for exceeding its cost limit. Amber tone
        // (#1113) matching the canonical "over budget" cue in linked-pull-summary.tsx and the
        // notification center, so the stalled state reads consistently wherever the PR appears.
        "cost-stopped":
          "border-amber-500/60 text-amber-700 dark:text-amber-300",
        unknown: "border-border text-muted-foreground",
        agent: "border-primary-border bg-primary-subtle text-link",
      },
    },
    defaultVariants: { tone: "closed" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ tone }), className)}
      {...props}
      data-debug-component="Badge"
    />
  );
}

export { badgeVariants };
