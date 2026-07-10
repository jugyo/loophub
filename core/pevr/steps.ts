import type { PevrFinding, PevrVerdictArtifact } from "./artifacts.ts";
import type { PevrStep } from "./compose.ts";

/**
 * State of the latest validated artifact of one type, as seen by the completion
 * query. `headSha` is the SHA the engine stamped at submission (§6.1); `placed`
 * is whether that latest artifact has a placement record (`pevr_placements`).
 * An accepted-but-unplaced artifact (§6.3) is `placed: false` and therefore
 * never completes its step.
 */
export type PevrLatestArtifactState = {
  headSha: string;
  placed: boolean;
};

/**
 * Pure inputs for {@link evaluatePevrSteps}. Everything is resolved by the
 * caller from `pevr_artifacts` × `pevr_placements` × the worktree head — this
 * function reads no DB / fs and knows nothing about PR body / comment markers.
 */
export type PevrStepEvalInput = {
  /** Current worktree HEAD, or null when it could not be resolved. */
  currentHead: string | null;
  /** Whether HEAD is ahead of the run's base branch. */
  headAheadOfBase: boolean;
  /** Latest validated `plan` artifact state, or null when none submitted. */
  plan: PevrLatestArtifactState | null;
  /** Latest validated `execution-report` artifact state. */
  execute: PevrLatestArtifactState | null;
  /** Latest validated `verdict` artifact state. */
  verify: PevrLatestArtifactState | null;
  /** Latest validated `reflection` artifact state. */
  reflect: PevrLatestArtifactState | null;
  /** Parsed content of the latest verdict artifact (for the rework summary). */
  latestVerdict: PevrVerdictArtifact | null;
};

export type PevrStepStatus = {
  complete: boolean;
  missing: string[];
};

export type PevrLatestVerdictSummary = {
  event: "pass" | "request_changes";
  summary: string;
  findings: PevrFinding[];
};

export type PevrStepStatuses = {
  plan: PevrStepStatus;
  execute: PevrStepStatus;
  verify: PevrStepStatus & { latest_verdict: PevrLatestVerdictSummary | null };
  reflect: PevrStepStatus;
};

function placedAtHead(
  state: PevrLatestArtifactState | null,
  currentHead: string | null,
): boolean {
  return Boolean(
    state?.placed && currentHead !== null && state.headSha === currentHead,
  );
}

/**
 * Evaluate the completion condition of each PEVR step (§6.5) as a pure query.
 *
 * - Plan / Reflect complete once a validated artifact of their type is placed.
 * - Execute completes when a validated execution-report is placed, its stamped
 *   SHA equals the current head, and the head is ahead of base.
 * - Verify completes when a validated verdict is placed and its stamped SHA
 *   equals the current head.
 *
 * Because Execute / Verify compare the stamped SHA to the current head, moving
 * the head forward turns a previously complete step back to incomplete (stale).
 */
export function evaluatePevrSteps(input: PevrStepEvalInput): PevrStepStatuses {
  const planComplete = Boolean(input.plan?.placed);
  const plan: PevrStepStatus = {
    complete: planComplete,
    missing: planComplete ? [] : ["no validated plan artifact placed"],
  };

  const executeMissing: string[] = [];
  if (!placedAtHead(input.execute, input.currentHead)) {
    executeMissing.push("no validated execution-report for current head");
  }
  if (!input.headAheadOfBase) {
    executeMissing.push("head equals base");
  }
  const execute: PevrStepStatus = {
    complete: executeMissing.length === 0,
    missing: executeMissing,
  };

  const verifyComplete = placedAtHead(input.verify, input.currentHead);
  const verify: PevrStepStatus & {
    latest_verdict: PevrLatestVerdictSummary | null;
  } = {
    complete: verifyComplete,
    missing: verifyComplete ? [] : ["no validated verdict for current head"],
    latest_verdict: input.latestVerdict
      ? {
          event: input.latestVerdict.event,
          summary: input.latestVerdict.summary,
          findings: input.latestVerdict.findings,
        }
      : null,
  };

  const reflectComplete = Boolean(input.reflect?.placed);
  const reflect: PevrStepStatus = {
    complete: reflectComplete,
    missing: reflectComplete ? [] : ["no validated reflection artifact placed"],
  };

  return { plan, execute, verify, reflect };
}

export const PEVR_STEP_ORDER: readonly PevrStep[] = [
  "plan",
  "execute",
  "verify",
  "reflect",
];
