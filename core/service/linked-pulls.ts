import type { SyncSubscriber } from "../domain-events.ts";
import * as S from "../store.ts";

// Close every still-open PR linked to the closed Issue. This procedure owns the lookup, state
// checks, comments and cascade publication; the subscriber registry only wires its reference.
export const closeLinkedPulls: SyncSubscriber<"issue.closed"> = (
  fact,
  { publish },
) => {
  for (const pull of S.allLinkedPullsForIssue(fact.issueId)) {
    if (pull.state !== "open" || pull.merged) continue;

    S.updateIssue(pull.id, { state: "closed" });
    S.createComment(
      pull.id,
      fact.actor,
      `Closed because linked issue #${fact.issueNumber} was closed.`,
    );
    publish({
      type: "pull.closed",
      repoId: fact.repoId,
      actor: fact.actor,
      pullId: pull.id,
      pullNumber: pull.number,
      linkedIssueId: fact.issueId,
      reason: {
        kind: "linked_issue_closed",
        issueNumber: fact.issueNumber,
      },
    });
  }
  return undefined;
};

// A merged PR closes its linked Issue. Other PR closure reasons intentionally do not cascade in
// this direction. Publishing issue.closed then lets the Issue handler close sibling PRs.
export const closeLinkedIssueAfterMerge: SyncSubscriber<"pull.closed"> = (
  fact,
  context,
) => {
  if (fact.reason.kind !== "merged" || fact.linkedIssueId == null)
    return undefined;

  const issue = S.getIssueById(fact.linkedIssueId);
  if (issue?.state !== "open") return undefined;

  S.updateIssue(issue.id, { state: "closed" });
  context.publish({
    type: "issue.closed",
    repoId: fact.repoId,
    actor: fact.actor,
    issueId: issue.id,
    issueNumber: issue.number,
    reason: { kind: "pull_merged", pullNumber: fact.pullNumber },
  });
  return undefined;
};
