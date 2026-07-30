import * as S from "../store.ts";
import { SOURCE_PAYLOAD_VERSION } from "../workflow/source-events.ts";

interface CloseOpenPullsInput {
  repoId: number;
  linkedIssueId: number;
  actor: string;
}

// Close historical linked PRs when their issue is explicitly closed. Session/process cleanup is
// intentionally absent: the existing PID-based dev lock recovery owns that lifecycle.
export function closeOpenPullsForIssue(input: CloseOpenPullsInput): number[] {
  const linkedIssue = S.getIssueById(input.linkedIssueId);
  if (!linkedIssue) return [];

  const closed: number[] = [];
  for (const pull of S.allLinkedPullsForIssue(input.linkedIssueId)) {
    if (pull.state !== "open" || pull.merged) continue;

    S.updateIssue(pull.id, { state: "closed" });
    S.createComment(
      pull.id,
      input.actor,
      `Closed because linked issue #${linkedIssue.number} was closed.`,
    );
    S.emitEvent(input.repoId, "pull_request.closed", input.actor, {
      number: pull.number,
      linked_issue: linkedIssue.number,
      source_payload_version: SOURCE_PAYLOAD_VERSION,
    });
    closed.push(pull.number);
  }
  return closed;
}
