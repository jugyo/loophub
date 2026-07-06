import {
  actorFor,
  ensureWritable,
  issueOr404,
  repoOr404,
  reviewNoteJSON,
  revParse,
  S,
  ServiceError,
} from "./shared.ts";

// ===== review notes (#204, PR-independent since #216) =====
// A review note is a short, fact-based description of one file's diff — what the file is, what
// changed, what to look at — to orient a reviewer. Each note is bound to a diff range
// (base_sha -> commit_sha) within a repo and a concrete file path; that tuple is its identity, so a
// note stands on its own without a PR. A PR may be associated optionally (pass `pr`): the note then
// also belongs to that PR and, if the range is omitted, defaults to the PR's current base/head.
function reviewNoteOr404(r: S.Repo, id: number): S.ReviewNoteRow {
  const n = S.getReviewNoteById(id);
  if (!n || n.repo_id !== r.id) throw new ServiceError(404, "Not Found");
  return n;
}

export const reviewNotes = {
  // List a repo's notes (newest first). All filters are optional: `pr` narrows to one PR's notes,
  // path to one file, baseSha/commitSha to one diff range. Filtering by (baseSha, commitSha, path)
  // is how a consumer fetches the notes for a bare commit range with no PR.
  list(
    name: string,
    opts: {
      pr?: number;
      path?: string;
      baseSha?: string;
      commitSha?: string;
    } = {},
  ) {
    const r = repoOr404(name);
    let issueId: number | undefined;
    if (opts.pr !== undefined) {
      issueId = issueOr404(r, opts.pr, "pull").id;
    }
    return S.listReviewNotes(r.id, {
      issueId,
      path: opts.path,
      baseSha: opts.baseSha,
      commitSha: opts.commitSha,
    }).map(reviewNoteJSON);
  },

  get(name: string, id: number) {
    const r = repoOr404(name);
    return reviewNoteJSON(reviewNoteOr404(r, id));
  },

  // Create a note for a file's diff range. Two modes:
  //   - PR-independent: pass baseSha + commitSha (the diff range). No PR is involved.
  //   - PR-associated: pass `pr`; the range defaults to the PR's current base/head when omitted, and
  //     the note links to the PR. An explicit range is still honored (e.g. to annotate a past commit).
  async create(
    name: string,
    input: {
      path: string;
      body: string;
      baseSha?: string;
      commitSha?: string;
      pr?: number;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    if (!input.path) throw new ServiceError(422, "path is required");
    if (!input.body) throw new ServiceError(422, "body is required");
    let issueId: number | null = null;
    let baseSha = input.baseSha ?? null;
    let commitSha = input.commitSha ?? null;
    if (input.pr !== undefined) {
      const pr = issueOr404(r, input.pr, "pull");
      issueId = pr.id;
      // Default the range to the PR's current base/head, resolved to concrete SHAs so the note
      // records the exact range, not a moving ref.
      const p = S.getPull(pr.id)!;
      baseSha = baseSha ?? (await revParse(r.local_path, p.base_ref)) ?? null;
      commitSha =
        commitSha ?? (await revParse(r.local_path, p.head_ref)) ?? null;
    }
    if (!baseSha || !commitSha)
      throw new ServiceError(
        422,
        "base_sha and commit_sha are required for the diff range (or pass pr to default them)",
      );
    const actor = actorFor(sessionId);
    const row = S.createReviewNote({
      repoId: r.id,
      issueId,
      baseSha,
      commitSha,
      path: input.path,
      body: input.body,
      author: actor,
    });
    const pr = issueId ? S.getIssueById(issueId) : null;
    S.emitEvent(r.id, "pull_request.review_note_created", actor, {
      ...(pr ? { number: pr.number } : {}),
      path: input.path,
      base_sha: baseSha,
      commit_sha: commitSha,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return reviewNoteJSON(row);
  },

  update(name: string, id: number, body: string, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const n = reviewNoteOr404(r, id);
    if (!body) throw new ServiceError(422, "body is required");
    const actor = actorFor(sessionId);
    const row = S.updateReviewNote(n.id, body)!;
    const pr = n.issue_id != null ? S.getIssueById(n.issue_id) : null;
    S.emitEvent(r.id, "pull_request.review_note_updated", actor, {
      number: pr?.number,
      path: n.path,
    });
    return reviewNoteJSON(row);
  },

  remove(name: string, id: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const n = reviewNoteOr404(r, id);
    const actor = actorFor(sessionId);
    S.deleteReviewNote(n.id);
    const pr = n.issue_id != null ? S.getIssueById(n.issue_id) : null;
    S.emitEvent(r.id, "pull_request.review_note_deleted", actor, {
      number: pr?.number,
      path: n.path,
    });
    return { deleted: true, id };
  },
};
