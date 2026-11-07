import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { commentEscalationJSON } from "../serialize.ts";
import * as S from "../store.ts";
import {
  truncateMarkdownReason,
  WORKFLOW_ESCALATION_REASON_MAX_LENGTH,
} from "../workflow/prompts.ts";
import { comments } from "./comments.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

type EffectStatus = {
  status: "completed" | "already_completed" | "pending" | "failed";
  error?: string;
};

type WorkflowEscalationDeps = {
  createComment(
    name: string,
    pr: number,
    body: string,
    actor: string,
    sessionId?: string | null,
  ): { id: number };
};

const defaultDeps: WorkflowEscalationDeps = {
  createComment: comments.createAgentForPull,
};

// The comment speaks for the workflow agent that asked: the parent, or the Execute child asking the
// human directly. Their session names embed the issue title, which is noise as a comment author, so
// the comment is attributed to the role instead; the body names the run.
type EscalationAuthor = "orchestrator" | "executor";

// The body the parent writes here is the human-facing escalation comment, so it is trimmed to the
// escalation limit instead of being rejected: an over-long comment is still the notification the
// human needs, while a 422 held the run without notifying anyone.
function reasonText(value: string): string {
  const reason = truncateMarkdownReason(
    value,
    WORKFLOW_ESCALATION_REASON_MAX_LENGTH,
  );
  if (!reason) {
    throw new ServiceError(422, "escalate-human requires a reason");
  }
  return reason;
}

// The choices are what the PR screen renders as radio buttons, so each is trimmed, blanks dropped and
// duplicates collapsed: two identical radio labels could not be told apart in the answer.
function optionTexts(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
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
    input: {
      run: number;
      reason: string;
      options?: string[];
      author?: EscalationAuthor;
    },
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
    const options = optionTexts(input.options);
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
        options,
      },
    );
    const body = `Workflow run ${run.id} requires human guidance.\n\n${reason}`;
    // The escalation row is written with its comment, so the PR screen never shows an escalation
    // comment without its choices, nor choices without the comment they answer.
    const prComment = runEffect(run.id, event.id, "escalation.pr-comment", () =>
      db.transaction(() => {
        const comment = deps.createComment(
          name,
          run.pr_number,
          body,
          input.author ?? "orchestrator",
          sessionId,
        );
        S.createWorkflowEscalation({
          runId: run.id,
          eventId: event.id,
          commentId: comment.id,
          options,
        });
      }),
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
      options,
      effects: {
        pr_comment: prComment,
      },
    };
  },

  /**
   * The human's answer to an escalation, picked from its choices on the PR screen. It is posted as
   * the human's own PR comment, so the run's parent receives it the same way as any other human
   * PR comment. Only the run's newest escalation can be answered, and only once.
   */
  answer(name: string, pr: number, commentId: number, option: string) {
    const repo = repoOr404(name);
    ensureWritable(repo);
    const row = issueOr404(repo, pr, "pull");
    return db.transaction(() => {
      const escalation = S.getWorkflowEscalationByComment(commentId);
      const comment = S.getComment(commentId);
      if (!escalation || comment?.issue_id !== row.id) {
        throw new ServiceError(404, "escalation not found");
      }
      if (escalation.answer !== null) {
        throw new ServiceError(409, "escalation is already answered");
      }
      if (escalation.superseded) {
        throw new ServiceError(
          409,
          "escalation was superseded by a newer escalation",
        );
      }
      const options = JSON.parse(escalation.options) as string[];
      if (!options.includes(option)) {
        throw new ServiceError(422, "option is not one of the escalation's");
      }
      S.answerWorkflowEscalation(escalation.id, option);
      comments.createHumanForPull(
        name,
        pr,
        `Answer to escalation comment #${commentId}:\n\n> ${option}`,
      );
      return commentEscalationJSON(
        S.getWorkflowEscalationByComment(commentId)!,
      );
    });
  },
};
