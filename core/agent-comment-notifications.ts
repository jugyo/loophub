import type { CommentAuthorType } from "./store/comments.ts";
import * as S from "./store.ts";

const BODY_PREVIEW_MAX = 280;

export type AgentCommentNotificationSource = "pr" | "diff";

/**
 * Create a topbar notification when a workflow agent posts on a PR.
 *
 * Only `author_type === "agent"` notifies: human posts must stay silent, and unattributed
 * `system` posts (including a Web UI session that never registered as `me`) must not either.
 * `source_key` is unique per comment/message so a re-entry of the same write is a no-op.
 */
export function maybeNotifyAgentComment(input: {
  repoId: number;
  pullNumber: number;
  commentId: number;
  authorType: CommentAuthorType;
  actor: string;
  body: string;
  source: AgentCommentNotificationSource;
}): S.NotificationRow | null {
  if (input.authorType !== "agent") return null;

  const preview = previewBody(input.body);
  const sourceKey = `agent-comment:${input.source}:${input.repoId}:${input.commentId}`;
  const notification = S.createNotification({
    repoId: input.repoId,
    kind: "agent_comment",
    title: "Agent comment",
    body: `${input.actor}: ${preview}`,
    resourceKind: "pull",
    resourceNumber: input.pullNumber,
    sourceKey,
  });
  if (!notification) return null;
  S.emitEvent(notification.repo_id, "notification.created", "loophub", {
    id: notification.id,
    kind: notification.kind,
    number: notification.resource_number,
  });
  return notification;
}

function previewBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= BODY_PREVIEW_MAX) return collapsed;
  return `${collapsed.slice(0, BODY_PREVIEW_MAX - 1)}…`;
}
