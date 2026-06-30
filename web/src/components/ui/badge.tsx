// Status badge pill. Tones mirror the v1 UI badge palette (src/ui.html) for
// state / review / conflict parity.

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
  {
    variants: {
      tone: {
        open: "border-green-600/60 text-green-600 dark:text-green-400",
        closed: "border-border text-muted-foreground",
        draft:
          "border-border bg-muted text-muted-foreground dark:text-muted-foreground",
        merged: "border-purple-600/60 text-purple-500 dark:text-purple-400",
        "review-approved":
          "border-green-600/60 text-green-600 dark:text-green-400",
        "review-changes": "border-destructive/50 text-destructive",
        "review-rereview":
          "border-amber-500/60 text-amber-600 dark:text-amber-400",
        "review-commented": "border-border text-muted-foreground",
        mergeable: "border-green-600/60 text-green-600 dark:text-green-400",
        conflict: "border-destructive/50 text-destructive",
        working:
          "border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-300",
        unknown: "border-border text-muted-foreground",
        agent:
          "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300",
      },
    },
    defaultVariants: { tone: "closed" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
