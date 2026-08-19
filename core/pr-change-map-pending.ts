// #344: "Generate change map" launches an agent and returns immediately, so the map appears
// asynchronously. Unlike the GitHub export (#2383) there is no record to open when the launch
// happens — a change map exists or it does not — so the only account of "a generation is running"
// is the click that started it, held by the client that made it. This bounds that for display only:
// the button stops reading as in-progress once the TTL passes, whether or not a map ever lands.
//
// It is a display bound, not a recovery mechanism. Nothing observes an agent that dies or gives up;
// that failure stays visible in the agent's own pane, and the operator can simply generate again.
// A second generation is harmless — maps are append-only, keyed by the head they describe.

// Generous relative to a normal generation: the agent reads the PR's whole base…HEAD diff and its
// tests before writing anything, so a large PR or a slow model must not drop the spinner mid-run.
export const PR_CHANGE_MAP_PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * Epoch ms at which a generation started at `startedAt` stops counting as in-progress, or null when
 * there is no usable start timestamp. Callers compare it against their own clock so a mounted UI
 * can also schedule its own expiry.
 */
export function prChangeMapPendingUntil(
  startedAt: string | null | undefined,
): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  return Number.isFinite(started)
    ? started + PR_CHANGE_MAP_PENDING_TTL_MS
    : null;
}
