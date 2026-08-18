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
