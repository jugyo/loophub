// #2383: "Create PR on GitHub" launches an agent and returns immediately, so the GitHub PR appears
// asynchronously. The export record (github_pulls) says whether one is in flight and when it began,
// but it has no terminal failed state: nothing observes an agent that dies or gives up, so a record
// left 'creating' would otherwise mean "in progress" forever. This bounds that for display only —
// an export that never lands stops reading as in-progress and the button becomes clickable again,
// rather than holding a spinner. It is a display bound, not a recovery mechanism: the record stays
// as it is, and the failure itself stays visible in the agent's own pane.

// Generous relative to a normal export (the agent writes a branch/title/body, then pushes and opens
// the Draft PR) so a slow model or a large push doesn't drop the spinner mid-run.
export const GITHUB_PR_EXPORT_PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Epoch ms at which an export started at `startedAt` stops counting as in-progress, or null when
 * there is no usable start timestamp. Callers compare it against their own clock so a mounted UI
 * can also schedule its own expiry.
 */
export function githubPrExportPendingUntil(
  startedAt: string | null | undefined,
): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  return Number.isFinite(started)
    ? started + GITHUB_PR_EXPORT_PENDING_TTL_MS
    : null;
}
