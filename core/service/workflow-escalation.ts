import { ServiceError } from "../errors.ts";
import * as S from "../store.ts";
import { inlineText } from "../workflow/prompts.ts";
import { comments } from "./comments.ts";
import { actorFor, ensureWritable, repoOr404 } from "./shared.ts";

type EffectStatus = {
  status: "completed" | "already_completed" | "pending" | "failed";
  error?: string;
};

type WorkflowEscalationDeps = {
  createComment(
    name: string,
    pr: number,
    body: string,
    sessionId?: string | null,
  ): unknown;
};

const defaultDeps: WorkflowEscalationDeps = {
  createComment: comments.createForPull,
};

function reasonText(value: string): string {
  const reason = inlineText(value);
  if (!reason) {
    throw new ServiceError(422, "escalate-human requires a reason");
  }
  if (reason.length > 500) {
    throw new ServiceError(
      422,
      "escalate-human reason must be at most 500 characters",
    );
  }
  return reason;
}

// Claim, effect and completion are deliberately three commit points, not one transaction: the claim
// must be durable before the effect runs, so a crash mid-effect leaves a pending receipt an operator
// can see rather than a silently retried escalation. The effect itself owns whatever atomicity its
// own writes need.
function runEffect(
  run: number,
  event: number,
  key: string,
  effect: () => unknown,
): EffectStatus {
  const receipt = S.beginWorkflowEventEffect(run, event, key);
  if (!receipt) {
    throw new ServiceError(422, `could not claim effect receipt: ${key}`);
  }
  if (!receipt.acquired) {
    return {
      status:
        receipt.row.status === "completed" ? "already_completed" : "pending",
    };
  }
  try {
    effect();
    S.completeWorkflowEventEffect(run, event, key);
    return { status: "completed" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const workflowEscalation = {
  escalateHuman(
    name: string,
    input: { run: number; reason: string },
    sessionId?: string | null,
    dependencyOverrides: Partial<WorkflowEscalationDeps> = {},
  ) {
    const deps = { ...defaultDeps, ...dependencyOverrides };
    const repo = repoOr404(name);
    ensureWritable(repo);
    const run = S.getWorkflowRun(input.run);
    if (!run) throw new ServiceError(404, "Workflow run not found");
    if (run.repo_id !== repo.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    const reason = reasonText(input.reason);
    const pr = S.getIssue(repo.id, run.pr_number);
    if (pr?.kind !== "pull") {
      throw new ServiceError(
        404,
        `Workflow run linked PR #${run.pr_number} not found`,
      );
    }
    const event = S.getOrCreateWorkflowHumanEscalationEvent(
      repo.id,
      actorFor(sessionId),
      {
        id: run.id,
        issue_number: run.issue_number,
        reason,
      },
    );
    const body = `Workflow run ${run.id} requires human guidance: ${reason}`;
    const prComment = runEffect(run.id, event.id, "escalation.pr-comment", () =>
      deps.createComment(name, run.pr_number, body, sessionId),
    );
    const ok =
      prComment.status === "completed" ||
      prComment.status === "already_completed";
    return {
      ok,
      run: run.id,
      event_id: event.id,
      pr: run.pr_number,
      reason,
      effects: {
        pr_comment: prComment,
      },
    };
  },
};
