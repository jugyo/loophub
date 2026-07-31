import { ServiceError } from "../errors.ts";
import { commentJSON } from "../serialize.ts";
import * as S from "../store.ts";
import {
  actorFor,
  commentActor,
  ensureWritable,
  issueOr404,
  repoOr404,
} from "./shared.ts";
import { projectWorkflowRunPullComment } from "./workflow-run-events.ts";

// ===== comments =====
export const COMMENT_REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀"] as const;

function commentWire(row: S.CommentRow, actor?: string) {
  return commentJSON(row, S.listCommentReactions(row.id), actor);
}

export const comments = {
  list(name: string, number: number, actor?: string) {
    const r = repoOr404(name);
    const row = issueOr404(r, number);
    return S.listComments(row.id).map((comment) => commentWire(comment, actor));
  },

  create(
    name: string,
    number: number,
    body: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    if (!body) throw new ServiceError(422, "body is required");
    const { actor, authorType } = commentActor(sessionId);
    return createIssueComment(r, row, body, actor, authorType, sessionId);
  },

  // The Web UI posts on behalf of the supervising human without registering a session, which
  // `commentActor()` would attribute to the unnamed system actor. Record the human directly, the
  // way `createHumanForPull` does for pull requests.
  createHumanForIssue(name: string, number: number, body: string) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    if (!body) throw new ServiceError(422, "body is required");
    return createIssueComment(r, row, body, "me", "human", null);
  },

  createForPull(
    name: string,
    number: number,
    body: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    if (!body) throw new ServiceError(422, "body is required");
    const { actor, authorType } = commentActor(sessionId);
    return createPullComment(
      r,
      row,
      number,
      body,
      actor,
      authorType,
      sessionId,
    );
  },

  createHumanForPull(name: string, number: number, body: string) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    if (!body) throw new ServiceError(422, "body is required");
    return createPullComment(r, row, number, body, "me", "human", null);
  },

  reactForPull(
    name: string,
    number: number,
    commentId: number,
    emoji: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const comment = S.getComment(commentId);
    if (!comment || comment.issue_id !== row.id) {
      throw new ServiceError(404, "PR comment not found");
    }
    if (!(COMMENT_REACTIONS as readonly string[]).includes(emoji)) {
      throw new ServiceError(422, "unsupported PR comment reaction");
    }
    const actor = actorFor(sessionId);
    S.setCommentReaction(comment.id, actor, emoji);
    return commentWire(comment, actor);
  },

  reactHumanForPull(
    name: string,
    number: number,
    commentId: number,
    emoji: string,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const comment = S.getComment(commentId);
    if (!comment || comment.issue_id !== row.id) {
      throw new ServiceError(404, "PR comment not found");
    }
    if (!(COMMENT_REACTIONS as readonly string[]).includes(emoji)) {
      throw new ServiceError(422, "unsupported PR comment reaction");
    }
    S.setCommentReaction(comment.id, "me", emoji);
    return commentWire(comment, "me");
  },
};

function createIssueComment(
  repo: S.Repo,
  row: S.IssueRow,
  body: string,
  actor: string,
  authorType: S.CommentAuthorType,
  sessionId?: string | null,
) {
  const m = S.createComment(row.id, actor, body, authorType);
  S.emitEvent(repo.id, "issue.commented", actor, {
    number: row.number,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
  return commentWire(m);
}

function createPullComment(
  repo: S.Repo,
  row: S.IssueRow,
  number: number,
  body: string,
  actor: string,
  authorType: S.CommentAuthorType,
  sessionId?: string | null,
) {
  const m = S.createComment(row.id, actor, body, authorType);
  const source = S.emitEvent(repo.id, "pull_request.commented", actor, {
    number: row.number,
    comment_id: m.id,
    author_type: authorType,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
  if (authorType === "human") {
    projectWorkflowRunPullComment({
      repoId: repo.id,
      prNumber: number,
      actor,
      source,
      comment: m,
    });
  }
  return commentWire(m);
}
