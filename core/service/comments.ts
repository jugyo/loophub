import { ServiceError } from "../errors.ts";
import { commentJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

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
    const actor = actorFor(sessionId);
    const m = S.createComment(row.id, actor, body);
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
    const actor = actorFor(sessionId);
    const m = S.createComment(row.id, actor, body);
    S.emitEvent(r.id, "issue.commented", actor, {
      number: row.number,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return commentJSON(m);
  },
};
