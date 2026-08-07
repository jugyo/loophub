import type { WorkflowRunEvent } from "./run-projection.ts";

/**
 * Which of a run's Verify children are reviewing a HEAD that no longer exists.
 *
 * A Verify child is pinned at launch to the head SHA it reviews, and its review is submitted
 * against that SHA. Once Execute commits again, `reviewIsFresh` (core/workflow/steps.ts) already
 * discards whatever that child eventually submits — this module names the same children early, so
 * the engine can stop them instead of paying for a review it will ignore.
 *
 * This module is pure: it classifies launch events and touches neither the DB, git nor herdr.
 */

/** A Verify child as its launch event recorded it. */
export interface VerifyChildLaunch {
  sessionId: string;
  headSha: string;
}

function verifyChildLaunch(event: WorkflowRunEvent): VerifyChildLaunch | null {
  const { session_id: sessionId, head_sha: headSha } = event.payload;
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (typeof headSha !== "string" || !headSha) return null;
  return { sessionId, headSha };
}

/**
 * The session ids of the Verify children whose reviewed HEAD is provably not the current one,
 * oldest launch first.
 *
 * Only a proven mismatch counts. A child whose launch recorded no head SHA, and every child when
 * HEAD itself could not be resolved, stays out: not knowing which HEAD a verifier is on is not the
 * same as knowing it is on an old one, and killing on a guess would take out a verifier that is
 * doing exactly the work the run is waiting for.
 */
export function staleVerifyChildSessions(
  launches: readonly WorkflowRunEvent[],
  currentHead: string | null,
): string[] {
  if (!currentHead) return [];
  // Keyed by session so a relaunch of the same child is judged by the HEAD it was last given, not
  // by whatever an earlier launch recorded.
  const headBySession = new Map<string, string>();
  for (const event of launches) {
    const launch = verifyChildLaunch(event);
    if (launch) headBySession.set(launch.sessionId, launch.headSha);
  }
  return [...headBySession]
    .filter(([, headSha]) => headSha !== currentHead)
    .map(([sessionId]) => sessionId);
}
