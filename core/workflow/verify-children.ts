import type { WorkflowRunEvent } from "./run-projection.ts";

/**
 * Every Verify child launched before a replacement, oldest launch first.
 *
 * Launch events are already scoped to one workflow run and filtered to Verify by the projection.
 * De-duplicating session ids avoids signalling a child twice if the same session was relaunched.
 */
export function priorVerifyChildSessions(
  launches: readonly WorkflowRunEvent[],
): string[] {
  const sessions = new Set<string>();
  for (const event of launches) {
    const sessionId = event.payload.session_id;
    if (typeof sessionId === "string" && sessionId) sessions.add(sessionId);
  }
  return [...sessions];
}

/**
 * How long a Verify child may hold a HEAD before a same-SHA turn done relaunches it instead of
 * being answered with "no progress". Suppressing the relaunch is what keeps a run from spending a
 * second review on a diff that has not changed (#2528); this bound is the escape hatch that stops
 * a child which died without submitting a review from pinning the run to that HEAD (#1857).
 */
export const VERIFY_STALL_TIMEOUT_MS = 30 * 60_000;

/** Whether the Verify child of `launch` has yet to announce its review. */
export function verifyLaunchPending(
  launch: WorkflowRunEvent | null,
  latestReviewSubmissionId: number | null,
): boolean {
  if (!launch) return false;
  return (
    latestReviewSubmissionId === null || latestReviewSubmissionId < launch.id
  );
}

/**
 * The latest transition that ended a running child's claim on the HEAD it was launched for: a
 * human hold stops the children, the resume that follows asks Verify to review with a fresh
 * child (#1872), and a relaunch replaces children that were lost. `activate_step` is deliberately not one of them — reactivating an Execute pane for
 * live input leaves the Verify child reviewing.
 */
export function latestVerifyClaimRelease(
  events: readonly WorkflowRunEvent[],
): WorkflowRunEvent | null {
  return (
    events.findLast(
      (event) =>
        event.type === "workflow_run.updated" &&
        (event.payload.transition === "await_human" ||
          event.payload.transition === "resume_after_human" ||
          event.payload.transition === "relaunch"),
    ) ?? null
  );
}

/**
 * Whether the latest Verify child is still expected to review `currentHead`. It is only when it
 * was launched for that exact SHA, has not submitted its review yet, has not had its claim
 * released since, and has not been running past the stall timeout.
 */
export function verifyRunningForHead(input: {
  launch: WorkflowRunEvent | null;
  latestReviewSubmissionId: number | null;
  claimRelease: WorkflowRunEvent | null;
  currentHead: string | null;
  now: number;
}): boolean {
  const { launch, currentHead } = input;
  if (!launch || currentHead === null) return false;
  if (launch.payload.head_sha !== currentHead) return false;
  if (!verifyLaunchPending(launch, input.latestReviewSubmissionId))
    return false;
  if (input.claimRelease !== null && input.claimRelease.id > launch.id)
    return false;
  return input.now - Date.parse(launch.created_at) < VERIFY_STALL_TIMEOUT_MS;
}
