/**
 * Resource boundaries a Workflow run is held to.
 *
 * These are limits core owns, not decisions: how many times a run may rework is a bound on what the
 * run may consume, so it outlives whichever component reads it. The refusal itself stays in the
 * service that performs the transition.
 */

/** How many reworks one run may take before a fresh `request_changes` goes to a human instead. */
export const WORKFLOW_REWORK_LIMIT = 8;
