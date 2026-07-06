import { pullNumberFromWorktreePath } from "../worktree-path.ts";
import { HERDR_ID } from "./terminal-launch.ts";

export const HERDR_INACTIVE_CLEANUP_INTERVAL_MS = 60_000;
export const HERDR_INACTIVE_CLEANUP_THRESHOLD_MS = 10 * 60_000;

export interface HerdrInactiveCleanupOptions {
  thresholdMs?: number;
  worktreeRoot?: string;
  fullName?: string;
  isPullClosed?: (pull: number) => boolean;
}

export interface HerdrInactiveCleanupCandidate {
  paneId: string;
  name: string;
  inactiveMs: number;
}

type RawHerdrAgent = Record<string, unknown>;

const TIMESTAMP_FIELDS = [
  "inactive_since",
  "inactive_at",
  "status_since",
  "status_changed_at",
  "last_status_change_at",
];

const MILLISECOND_FIELDS = [
  "inactive_ms",
  "inactive_milliseconds",
  "inactive_for_ms",
];

const SECOND_FIELDS = [
  "inactive_seconds",
  "inactive_for_seconds",
  "inactive_duration_seconds",
];

export function parseHerdrInactiveCleanupCandidates(
  stdout: string,
  nowMs: number = Date.now(),
  thresholdOrOptions:
    | number
    | HerdrInactiveCleanupOptions = HERDR_INACTIVE_CLEANUP_THRESHOLD_MS,
): HerdrInactiveCleanupCandidate[] {
  const options: HerdrInactiveCleanupOptions =
    typeof thresholdOrOptions === "number"
      ? { thresholdMs: thresholdOrOptions }
      : thresholdOrOptions;
  const thresholdMs =
    options.thresholdMs ?? HERDR_INACTIVE_CLEANUP_THRESHOLD_MS;

  const agents = rawHerdrAgents(stdout);
  const candidates: HerdrInactiveCleanupCandidate[] = [];
  for (const agent of agents) {
    const candidate = herdrInactiveCleanupCandidate(
      agent,
      nowMs,
      thresholdMs,
      options,
    );
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function herdrInactiveCleanupCandidate(
  agent: RawHerdrAgent,
  nowMs: number = Date.now(),
  thresholdMs: number = HERDR_INACTIVE_CLEANUP_THRESHOLD_MS,
  options: HerdrInactiveCleanupOptions = {},
): HerdrInactiveCleanupCandidate | null {
  const status =
    typeof agent.agent_status === "string" ? agent.agent_status : "";
  if (status === "active" || status === "working") return null;

  const isPullClosed =
    typeof options.isPullClosed === "function"
      ? isPullClosedAgent(agent, options)
      : false;
  const isNoPrIdle =
    status === "idle" && herdrAgentPull(agent, options) === null;

  if (status !== "inactive" && !isPullClosed && !isNoPrIdle) return null;

  if (typeof agent.pane_id !== "string" || !HERDR_ID.test(agent.pane_id))
    return null;

  const inactiveMs = inactiveAgeMs(agent, nowMs);
  // If Herdr does not report inactivity age, keep the pane. That makes the fallback explicit
  // and avoids closing a pane that just became inactive.
  if (inactiveMs === null || inactiveMs < thresholdMs) return null;

  return {
    paneId: agent.pane_id,
    name: typeof agent.name === "string" ? agent.name : agent.pane_id,
    inactiveMs,
  };
}

function rawHerdrAgents(stdout: string): RawHerdrAgent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const agents = (parsed as { result?: { agents?: unknown } })?.result?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.filter(
    (agent): agent is RawHerdrAgent =>
      typeof agent === "object" && agent !== null,
  );
}

function inactiveAgeMs(agent: RawHerdrAgent, nowMs: number): number | null {
  for (const field of MILLISECOND_FIELDS) {
    const value = nonNegativeNumber(agent[field]);
    if (value !== null) return value;
  }
  for (const field of SECOND_FIELDS) {
    const value = nonNegativeNumber(agent[field]);
    if (value !== null) return value * 1000;
  }
  for (const field of TIMESTAMP_FIELDS) {
    const value = agent[field];
    if (typeof value !== "string" || value === "") continue;
    const then = Date.parse(value);
    if (!Number.isFinite(then)) continue;
    return Math.max(0, nowMs - then);
  }
  return null;
}

function herdrAgentPull(
  agent: RawHerdrAgent,
  options: HerdrInactiveCleanupOptions,
): number | null {
  if (
    typeof options.worktreeRoot !== "string" ||
    typeof options.fullName !== "string"
  ) {
    return null;
  }
  const cwd =
    typeof agent.foreground_cwd === "string" && agent.foreground_cwd !== ""
      ? agent.foreground_cwd
      : typeof agent.cwd === "string" && agent.cwd !== ""
        ? agent.cwd
        : null;
  if (cwd === null) return null;
  try {
    return pullNumberFromWorktreePath(
      options.worktreeRoot,
      options.fullName,
      cwd,
    );
  } catch {
    return null;
  }
}

function isPullClosedAgent(
  agent: RawHerdrAgent,
  options: HerdrInactiveCleanupOptions,
): boolean {
  if (typeof options.isPullClosed !== "function") return false;
  const pull = herdrAgentPull(agent, options);
  if (pull === null) return false;
  return options.isPullClosed(pull);
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
