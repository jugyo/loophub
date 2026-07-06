import { db, now } from "../db.ts";

// ---- handoffs (#352) ----
// A handoff is one explicit document passed between a parent orchestrator and a child subagent
// (lh-build-design.ja.md §6.5). Linked to a PR (prId) and/or a generic issue (issueId), plus the
// session that recorded it (sessionId); `seq` orders handoffs per ref. Body is hybrid: inline
// `body` for content with no other home, or `src`+`hash` referencing a canonical copy (PR/commit).
// These functions are pure store access — validation, ref resolution and the body/src XOR live in
// service.ts.
export interface HandoffInput {
  repoId: number;
  prId?: number | null;
  issueId?: number | null;
  sessionId?: string | null;
  phase: string;
  direction: string;
  fromRole?: string | null;
  toRole?: string | null;
  body?: string | null;
  src?: string | null;
  hash?: string | null;
  summary?: string | null;
  model?: string | null;
  cost?: string | null;
}

export interface HandoffRow {
  id: number;
  repo_id: number;
  pr_id: number | null;
  issue_id: number | null;
  session_id: string | null;
  seq: number;
  phase: string;
  direction: string;
  from_role: string | null;
  to_role: string | null;
  body: string | null;
  src: string | null;
  hash: string | null;
  summary: string | null;
  model: string | null;
  cost: string | null;
  created_at: string;
}

// The next sequence number for a handoff's PRIMARY ref. Scope priority: the PR when present
// (handoffs accumulate on the PR), else the generic issue, else the session — the same key the row
// is filed under, and exactly what the UNIQUE partial indexes in db.ts enforce. Counting only rows
// that share that anchor keeps each ref's seq a clean 1,2,3… independent of other refs. A handoff
// binds to a single primary scope for seq purposes: binding both a PR and an issue mints seq in the
// PR scope (the issue is then a secondary link, not a second counter).
export function nextHandoffSeq(input: {
  prId?: number | null;
  issueId?: number | null;
  sessionId?: string | null;
}): number {
  let where: string;
  let param: number | string;
  if (input.prId != null) {
    where = "pr_id = ?";
    param = input.prId;
  } else if (input.issueId != null) {
    // Match the partial UNIQUE issue index predicate exactly (pr_id IS NULL AND issue_id IS NOT
    // NULL): count only issue-ONLY rows, so a dual-bound (pr+issue) row's PR-scope seq does not
    // inflate this issue's counter — keeping the per-issue seq a clean 1,2,3… as documented.
    where = "issue_id = ? AND pr_id IS NULL";
    param = input.issueId;
  } else {
    where = "session_id = ?";
    param = input.sessionId ?? "";
  }
  const row = db
    .query(`SELECT COALESCE(MAX(seq), 0) AS max FROM handoffs WHERE ${where}`)
    .get(param) as { max: number };
  return (row?.max ?? 0) + 1;
}

// Detect a UNIQUE-constraint failure from node:sqlite (errcode SQLITE_CONSTRAINT_UNIQUE = 2067,
// or the message text), distinct from SQLITE_BUSY. Used to retry a raced seq below.
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errcode?: number; message?: string };
  return (
    e.errcode === 2067 || /UNIQUE constraint failed/i.test(e.message ?? "")
  );
}

export function createHandoff(input: HandoffInput): HandoffRow {
  // seq is MAX(seq)+1 read then INSERTed in two statements, so two processes (parallel
  // `lh handoff record` from concurrent subagents) can read the same MAX and pick the same seq.
  // The UNIQUE (ref, seq) partial index (db.ts) makes the loser's INSERT throw rather than
  // duplicate; recompute seq and retry a few times so it lands on the next free number. Same
  // robustness as issues' UNIQUE (repo_id, number) backing nextNumber, made explicit here.
  for (let attempt = 0; ; attempt++) {
    const seq = nextHandoffSeq(input);
    try {
      return db
        .query(
          `INSERT INTO handoffs
            (repo_id, pr_id, issue_id, session_id, seq, phase, direction,
             from_role, to_role, body, src, hash, summary, model, cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          input.repoId,
          input.prId ?? null,
          input.issueId ?? null,
          input.sessionId ?? null,
          seq,
          input.phase,
          input.direction,
          input.fromRole ?? null,
          input.toRole ?? null,
          input.body ?? null,
          input.src ?? null,
          input.hash ?? null,
          input.summary ?? null,
          input.model ?? null,
          input.cost ?? null,
          now(),
        ) as HandoffRow;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 5) continue;
      throw err;
    }
  }
}

export function getHandoffById(id: number): HandoffRow | null {
  return db
    .query(`SELECT * FROM handoffs WHERE id = ?`)
    .get(id) as HandoffRow | null;
}

// List handoffs for a ref, in chronological order (seq asc, id breaking ties). All filters
// optional: prId narrows to one PR, issueId to a generic issue, sessionId to a session. With none,
// returns the repo's handoffs (repoId always scopes the result).
export function listHandoffs(
  repoId: number,
  opts: { prId?: number; issueId?: number; sessionId?: string } = {},
): HandoffRow[] {
  const conds = ["repo_id = ?"];
  const params: unknown[] = [repoId];
  if (opts.prId !== undefined) {
    conds.push("pr_id = ?");
    params.push(opts.prId);
  }
  if (opts.issueId !== undefined) {
    conds.push("issue_id = ?");
    params.push(opts.issueId);
  }
  if (opts.sessionId !== undefined) {
    conds.push("session_id = ?");
    params.push(opts.sessionId);
  }
  return db
    .query(
      `SELECT * FROM handoffs WHERE ${conds.join(" AND ")}
       ORDER BY seq ASC, id ASC`,
    )
    .all(...params) as HandoffRow[];
}
