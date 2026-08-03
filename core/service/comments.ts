import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { commentJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { SOURCE_PAYLOAD_VERSION } from "../workflow/source-events.ts";
import {
  actorFor,
  commentActor,
  ensureWritable,
  issueOr404,
  repoOr404,
} from "./shared.ts";

// ===== comments =====
export const COMMENT_REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀"] as const;

function commentWire(row: S.CommentRow, actor?: string) {
  return commentJSON(row, S.listCommentReactions(row.id), actor);
}

export const comments = {
  list(name: string, number: number, actor?: string) {
    const r = repoOr404(name);
    const row = issueOr404(r, number);
    const reactions = S.commentReactionsByIssue(row.id);
    return S.listComments(row.id).map((comment) =>
      commentJSON(comment, reactions.get(comment.id) ?? [], actor),
    );
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
    return createPullComment(r, row, body, actor, authorType, sessionId);
  },

  createHumanForPull(name: string, number: number, body: string) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    if (!body) throw new ServiceError(422, "body is required");
    return createPullComment(r, row, body, "me", "human", null);
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
    // The reaction toggle reads the current row before writing, so the write and the read that
    // renders it belong to one transaction.
    return db.transaction(() => {
      S.setCommentReaction(comment.id, actor, emoji);
      return commentWire(comment, actor);
    });
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
    return db.transaction(() => {
      S.setCommentReaction(comment.id, "me", emoji);
      return commentWire(comment, "me");
    });
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
  return db.transaction(() => {
    const m = S.createComment(row.id, actor, body, authorType);
    S.emitEvent(repo.id, "issue.commented", actor, {
      number: row.number,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return commentWire(m);
  });
}

function createPullComment(
  repo: S.Repo,
  row: S.IssueRow,
  body: string,
  actor: string,
  authorType: S.CommentAuthorType,
  sessionId?: string | null,
) {
  return db.transaction(() => {
    const m = S.createComment(row.id, actor, body, authorType);
    // `author_type` is what tells a Workflow run whether this comment is an instruction: only a
    // human's is. The run reads it off the source rather than being told by a separate event.
    S.emitEvent(repo.id, "pull_request.commented", actor, {
      number: row.number,
      comment_id: m.id,
      author_type: authorType,
      source_payload_version: SOURCE_PAYLOAD_VERSION,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return commentWire(m);
  });
}
