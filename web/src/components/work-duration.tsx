// Work duration section for the PR detail sidebar (#456): how long the PR's dev session took, so a
// reader can tell a quick fix from a long-running loop at a glance. Always renders — unlike Sessions
// / Handoffs, which hide themselves when a PR has nothing to show — because the AC requires an
// explicit, readable fallback ("N/A") rather than silently disappearing when duration can't be
// computed (e.g. a human-authored PR with no dev session).
//
// Shows three figures (serialize.ts `pullWorkDuration`):
//   - Total: session start → the clearest completion signal, or now while still open. The basis
//     label says which — "merged" / "closed" are terminal (the number is fixed); "in review" /
//     "in progress" mean it's still measured up to now and keeps growing.
//   - Implementation: session start → the first ready_for_review event — the phase before a
//     reviewer ever saw the PR.
//   - Review: that event → merge/close, or now while still under review. Omitted until the PR has
//     reached ready_for_review at least once — there is nothing to report yet.

import type { PullRequest } from "@/api/types";
import { formatDuration } from "@/lib/time";

type WorkDuration = NonNullable<PullRequest["work_duration"]>;

const TOTAL_BASIS_LABEL: Record<
  NonNullable<WorkDuration["total"]["basis"]>,
  string
> = {
  merged: "merged",
  closed: "closed",
  in_review: "in review",
  in_progress: "in progress",
};

function phaseText(phase: { seconds: number | null; done: boolean } | null) {
  if (!phase || phase.seconds == null) return null;
  return phase.done
    ? formatDuration(phase.seconds)
    : `${formatDuration(phase.seconds)} so far`;
}

export function WorkDuration({
  workDuration,
}: {
  workDuration: PullRequest["work_duration"];
}) {
  const total = workDuration?.total ?? { seconds: null, basis: null };
  const implementationText = phaseText(workDuration?.implementation ?? null);
  const reviewText = phaseText(workDuration?.review ?? null);

  return (
    <section
      data-debug-component="WorkDuration"
      className="flex flex-col gap-1"
    >
      <h2 className="text-lg font-semibold">Work duration</h2>
      {total.seconds == null || total.basis == null ? (
        <p className="text-sm text-muted-foreground">N/A</p>
      ) : (
        <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
          <p>
            {formatDuration(total.seconds)} ({TOTAL_BASIS_LABEL[total.basis]})
          </p>
          {implementationText ? (
            <p className="text-xs">Implementation: {implementationText}</p>
          ) : null}
          {reviewText ? <p className="text-xs">Review: {reviewText}</p> : null}
        </div>
      )}
    </section>
  );
}
