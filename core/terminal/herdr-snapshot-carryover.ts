import type { HerdrSessionsWire } from "../serialize.ts";

// Keeps a repo's agents on screen when its own `herdr agent list` capture failed (#2142).
//
// The sweep reports such repos in capture_failed_repos instead of silently dropping them, because
// a dropped group is indistinguishable from "this repo has no agents" — the failure used to be
// invisible in both the UI and the logs. Here the last known group for each failed repo is carried
// over and tagged with stale_since, so the snapshot says "this is what we last saw, and this is
// when we saw it" rather than "nobody is running".
//
// stale_since is stamped once, from the captured_at of the snapshot the group is carried over
// from, and preserved across further failures — a human reads it as "updates stopped at this
// time", and freezing it also keeps the structural signature stable so a repo that keeps failing
// does not emit a change event every tick. A repo that captures again drops the tag on its own,
// since the fresh group simply replaces the carried-over one.
//
// This is deliberately not automatic recovery: nothing is retried, and the top-level captured_at
// still advances every tick so the snapshot as a whole never reads as fresher than it is.
export function carryOverFailedRepoSessions(
  snapshot: HerdrSessionsWire,
  previous: { snapshot: HerdrSessionsWire; captured_at: string } | null,
): HerdrSessionsWire {
  const failed = snapshot.capture_failed_repos ?? [];
  if (failed.length === 0 || !previous) return snapshot;
  const carried = failed
    .map((repo) => previous.snapshot.repos.find((g) => g.repo === repo))
    .filter((group) => group !== undefined)
    .map((group) => ({
      ...group,
      stale_since: group.stale_since ?? previous.captured_at,
    }));
  if (carried.length === 0) return snapshot;
  return { ...snapshot, repos: [...snapshot.repos, ...carried] };
}
