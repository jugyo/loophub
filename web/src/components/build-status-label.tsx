// Disabled label shown in the issue-detail header in place of the Build button
// once the issue's primary linked PR is open or merged (#598): "Building"
// while it's open and unmerged, "Merged" once it merged. Deliberately not a
// `Badge` pill (ui/badge.tsx / lib/badges.ts) — those already carry PR-status
// meaning (e.g. linkedPullStatus's purple "merged" pill on the PR sub-row), so
// a same-shaped label here would read as another status badge. A muted,
// rounded-md chip keeps it visually distinct while echoing a disabled button.

import { CheckCircle2, Hammer } from "lucide-react";
import type { BuildButtonState } from "@/lib/badges";

export function BuildStatusLabel({
  state,
}: {
  state: Exclude<BuildButtonState, "build">;
}) {
  const Icon = state === "merged" ? CheckCircle2 : Hammer;
  const text = state === "merged" ? "Merged" : "Building";
  return (
    <span
      title={text}
      className="inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border bg-muted px-4 py-2 text-sm font-medium text-muted-foreground opacity-80"
    >
      <Icon className="size-4" />
      {text}
    </span>
  );
}
