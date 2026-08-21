import * as S from "./store.ts";

/**
 * Create a topbar notification when a loophub PR gains its GitHub PR link.
 *
 * "Create PR on GitHub" launches an agent and returns immediately (#2383), so the only signal that
 * the export finished is `github_pulls` reaching 'linked'. Notifying from the recording path — the
 * one both the orchestrated export and a hand-recorded link (#487) pass through — lets an AFK
 * supervisor see the success without polling the PR page. The resource is the loophub PR, so the
 * notification opens PR detail; the GitHub PR itself is one click further, in the sidebar.
 *
 * `source_key` is unique per linked GitHub PR, so re-recording the same one (a re-run, an overwrite,
 * or an unlink/re-link) is a no-op while a link corrected to a different GitHub PR notifies again.
 */
export function notifyGithubPullLinked(input: {
  repoId: number;
  repoFullName: string;
  pullNumber: number;
  githubNumber: number;
}): S.NotificationRow | null {
  const notification = S.createNotification({
    repoId: input.repoId,
    kind: "github_pr_linked",
    title: "GitHub PR created",
    body: `PR #${input.pullNumber} in ${input.repoFullName} is linked to GitHub PR #${input.githubNumber}.`,
    resourceKind: "pull",
    resourceNumber: input.pullNumber,
    sourceKey: `github-pr-linked:${input.repoId}:${input.pullNumber}:${input.githubNumber}`,
  });
  if (!notification) return null;
  S.emitEvent(notification.repo_id, "notification.created", "loophub", {
    id: notification.id,
    kind: notification.kind,
    number: notification.resource_number,
  });
  return notification;
}
