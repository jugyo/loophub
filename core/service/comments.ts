import { ServiceError } from "../errors.ts";
import { commentJSON } from "../serialize.ts";
import * as S from "../store.ts";
import {
  commentActor,
  ensureWritable,
  issueOr404,
  repoOr404,
} from "./shared.ts";
import { projectWorkflowRunPullComment } from "./workflow-run-events.ts";

// ===== comments =====
export const comments = {
  list(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number);
    return S.listComments(row.id).map(commentJSON);
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
    const m = S.createComment(row.id, actor, body, authorType);
    S.emitEvent(r.id, "issue.commented", actor, {
      number: row.number,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return commentJSON(m);
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
};

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
  return commentJSON(m);
}
