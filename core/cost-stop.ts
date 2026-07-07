// Pure, side-effect-free decisioning for the dev cost-limit stop (#832). The worker's cost-stop
// sweep (worker/maintenance.ts → terminal.enforceDevCostLimits) composes this over herdr pane
// enumeration + session usage; keeping the judgement here makes it unit-testable without herdr or
// the DB, mirroring how core/worktree-prune.ts backs `lh worktree prune`.

// Default top-level cumulative cost (USD) at which a `lh dev` implementation agent is stopped.
// Adding a UI to change the limit is out of scope (#832); an env override exists for operators and
// tests only.
export const DEFAULT_DEV_COST_LIMIT_USD = 10;

// Stored as the `reason` on the dev.cost_stopped event so a human can later tell *why* the agent
// was stopped from the event log alone (AC: 停止理由が event ログから分かる).
export const COST_STOP_REASON = "cost_limit_exceeded";
export const DEV_COST_STOPPED_EVENT = "dev.cost_stopped";

// Resolve the limit from the environment, falling back to the default. Only a finite, positive
// number overrides — a malformed LOOPHUB_DEV_COST_LIMIT_USD is ignored rather than disabling the
// guard.
export function devCostLimitUsd(): number {
  const raw = process.env.LOOPHUB_DEV_COST_LIMIT_USD;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_DEV_COST_LIMIT_USD;
}

export interface CostStopInput {
  // Top-level cumulative cost for the pane's dev session, in USD. null means the cost is unknown
  // (an unknown-priced model in the usage rows) — an ambiguous state, so we never stop on it.
  costUsd: number | null;
  limitUsd: number;
  // The dev.cost_stopped event already exists for this PR — we've stopped it before.
  alreadyStopped: boolean;
  // A primary dev session is linked to the pane's PR. Without one we can't attribute cost, so the
  // live state is ambiguous and we don't stop.
  hasDevSession: boolean;
}

export type CostStopDecision =
  | { action: "stop"; costUsd: number }
  // "retryable" — the live state is ambiguous this tick (no dev session, or unknown cost); do not
  // stop, just try again next sweep. "settled" — a definite no-op (under the limit, or already
  // stopped). Both are non-actions, but the split lets the caller surface retryable ambiguity.
  | {
      action: "skip";
      retryable: boolean;
      reason: "already_stopped" | "under_limit" | "unknown_cost" | "no_session";
    };

// Decide whether the pane's dev agent should be stopped this tick. Ordering matters: an
// already-stopped PR is a settled no-op regardless of cost (idempotency), and ambiguous states
// (no session / unknown cost) never stop.
export function decideCostStop(input: CostStopInput): CostStopDecision {
  if (input.alreadyStopped) {
    return { action: "skip", retryable: false, reason: "already_stopped" };
  }
  if (!input.hasDevSession) {
    return { action: "skip", retryable: true, reason: "no_session" };
  }
  if (input.costUsd === null) {
    return { action: "skip", retryable: true, reason: "unknown_cost" };
  }
  if (input.costUsd > input.limitUsd) {
    return { action: "stop", costUsd: input.costUsd };
  }
  return { action: "skip", retryable: false, reason: "under_limit" };
}
