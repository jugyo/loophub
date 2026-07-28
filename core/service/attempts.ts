import * as S from "../store.ts";
import { projectWorkflowRunClosed } from "./workflow-run-events.ts";

interface CloseOpenAttemptsInput {
  repoId: number;
  linkedIssueId: number;
  actor: string;
  supersededByPull?: number;
}

// Close every still-open proposal for an issue once that issue reaches a terminal state. This is
// shared by the direct issue-close and PR-merge paths so neither can leave open attempts attached
// to a closed issue. Session/process cleanup is intentionally absent: the existing PID-based dev
// lock recovery owns that lifecycle.
export function closeOpenAttemptsForIssue(
  input: CloseOpenAttemptsInput,
): number[] {
  const linkedIssue = S.getIssueById(input.linkedIssueId);
  if (!linkedIssue) return [];

  const closed: number[] = [];
  for (const pull of S.allLinkedPullsForIssue(input.linkedIssueId)) {
    if (pull.state !== "open" || pull.merged) continue;

    S.updateIssue(pull.id, { state: "closed" });
    S.createComment(
      pull.id,
      input.actor,
      input.supersededByPull !== undefined
        ? `Superseded by #${input.supersededByPull}.`
        : `Closed because linked issue #${linkedIssue.number} was closed.`,
    );
    const closedEvent = S.emitEvent(
      input.repoId,
      "pull_request.closed",
      input.actor,
      {
        number: pull.number,
        linked_issue: linkedIssue.number,
        ...(input.supersededByPull !== undefined
          ? { superseded_by: input.supersededByPull }
          : {}),
      },
    );
    projectWorkflowRunClosed(
      input.repoId,
      pull.number,
      input.actor,
      closedEvent,
    );
    closed.push(pull.number);
  }
  return closed;
}
