import { db, now } from "../db.ts";
import { listSessionUsage } from "./session-usage.ts";

export interface AgentSessionRow {
  id: string;
  agent: string;
  external_session: string;
  name: string | null;
  runtime: string | null;
  kind: string | null;
  model: string | null;
  effort: string | null;
  created_at: string;
  updated_at: string;
}

export type LinkedAgentSessionRow = AgentSessionRow & {
  linked_at: string;
};

export interface PullAgentSummary {
  agent: string;
  runtime: string | null;
  models: string[];
}

export interface SessionLinkedTargetRow {
  repo_id: number;
  repo: string;
  kind: "issue" | "pull";
  number: number;
  title: string;
  state: string;
}

// ---- agent sessions ----
export function getAgentSession(id: string): AgentSessionRow | null {
  return (
    (db
      .query(`SELECT * FROM agent_sessions WHERE id = ?`)
      .get(id) as AgentSessionRow | null) ?? null
  );
}

export function listAgentSessions(): AgentSessionRow[] {
  return db
    .query(`SELECT * FROM agent_sessions ORDER BY updated_at DESC`)
    .all() as AgentSessionRow[];
}

// The default usage sweep's candidate set (#1119): sessions linked to an open PR.
export function listSessionsForUsageSweep(): AgentSessionRow[] {
  return db
    .query(
      `SELECT DISTINCT s.*
       FROM agent_sessions s
       JOIN session_links l ON l.session_id = s.id
       JOIN issues i ON i.id = l.issue_id
       LEFT JOIN pulls p ON p.issue_id = i.id
       WHERE i.kind = 'pull' AND i.state = 'open' AND p.merged = 0 AND p.archived_at IS NULL
       ORDER BY s.updated_at DESC`,
    )
    .all() as AgentSessionRow[];
}

export type RegisterConflict = "CONFLICT_ID" | "CONFLICT_PAIR";

export function registerAgentSession(
  id: string,
  agent: string,
  externalSession: string,
  name?: string | null,
  runtime?: string | null,
  kind?: string | null,
  model?: string | null,
  createdAt?: string | null,
  effort?: string | null,
): { session: AgentSessionRow; created: boolean } {
  const existing = getAgentSession(id);
  const t = now();
  if (existing) {
    if (
      existing.agent !== agent ||
      existing.external_session !== externalSession
    ) {
      throw new Error("CONFLICT_ID" satisfies RegisterConflict);
    }
    // Preserve-on-re-register: an undefined arg keeps the stored value (the service layer relies on
    // this — it forwards name/runtime/kind straight through without `?? null`).
    db.run(
      `UPDATE agent_sessions SET name = ?, runtime = ?, kind = ?, model = ?, effort = ?, updated_at = ? WHERE id = ?`,
      [
        name !== undefined ? name : existing.name,
        runtime !== undefined ? runtime : existing.runtime,
        kind !== undefined ? kind : existing.kind,
        model !== undefined ? model : existing.model,
        effort !== undefined ? effort : existing.effort,
        t,
        id,
      ],
    );
    return { session: getAgentSession(id) as AgentSessionRow, created: false };
  }
  const byPair = db
    .query(
      `SELECT id FROM agent_sessions WHERE agent = ? AND external_session = ?`,
    )
    .get(agent, externalSession) as { id: string } | null;
  if (byPair) throw new Error("CONFLICT_PAIR" satisfies RegisterConflict);
  db.query(
    `INSERT INTO agent_sessions (id, agent, external_session, name, runtime, kind, model, effort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(
    id,
    agent,
    externalSession,
    name ?? null,
    runtime ?? null,
    kind ?? null,
    model ?? null,
    effort ?? null,
    createdAt ?? t,
    t,
  );
  return { session: getAgentSession(id) as AgentSessionRow, created: true };
}

export function setAgentSessionExternalSession(
  sessionId: string,
  externalSession: string,
) {
  db.run(
    `UPDATE agent_sessions SET external_session = ?, updated_at = ? WHERE id = ?`,
    [externalSession, now(), sessionId],
  );
}

// Workflow parents are registered before PR/worktree preparation so the run can refer to them.
// Once the process launch succeeds, replace that provisional timestamp with the actual launch
// boundary used for transcript correlation.
export function setAgentSessionCreatedAt(sessionId: string, createdAt: string) {
  db.run(`UPDATE agent_sessions SET created_at = ? WHERE id = ?`, [
    createdAt,
    sessionId,
  ]);
}

// Set a session's kind in place (#298). Used when the kind becomes known at association time (e.g.
// a launcher stamps its session 'dev' when it links the PR). No-op if the session row is absent.
export function setSessionKind(sessionId: string, kind: string) {
  db.run(`UPDATE agent_sessions SET kind = ?, updated_at = ? WHERE id = ?`, [
    kind,
    now(),
    sessionId,
  ]);
}

// Link a session to an issues row (issue or PR) in the generalized session_links bridge (#298).
// Idempotent — the (session_id, issue_id) pair is the PK, so re-linking keeps the original
// created_at (INSERT OR IGNORE). The first link's created_at orders the related-sessions list.
export function linkSession(sessionId: string, issueId: number) {
  db.run(
    `INSERT OR IGNORE INTO session_links (session_id, issue_id, created_at)
     VALUES (?, ?, ?)`,
    [sessionId, issueId, now()],
  );
}

// All sessions linked to an issues row (issue or PR), newest link first. Joins the bridge to the
// session rows so callers get the full session (incl. kind/runtime) for the related-sessions list.
// `linked_at` is the bridge row's created_at (when this session was attached to this target).
export function listSessionsForIssue(issueId: number): LinkedAgentSessionRow[] {
  return db
    .query(
      // l.rowid DESC is the tiebreaker: now() is second-resolution, so links made in the same
      // second share created_at; rowid (monotonic insert order) keeps newest-linked-first stable.
      `SELECT s.*, l.created_at AS linked_at
       FROM session_links l
       JOIN agent_sessions s ON s.id = l.session_id
       WHERE l.issue_id = ?
       ORDER BY l.created_at DESC, l.rowid DESC`,
    )
    .all(issueId) as LinkedAgentSessionRow[];
}

export function listSessionLinkedTargets(
  sessionId: string,
): SessionLinkedTargetRow[] {
  return db
    .query(
      `SELECT
         i.repo_id,
         r.full_name AS repo,
         i.kind,
         i.number,
         i.title,
         i.state
       FROM session_links l
       JOIN issues i ON i.id = l.issue_id
       JOIN repos r ON r.id = i.repo_id
       WHERE l.session_id = ?
       ORDER BY r.full_name, i.kind, i.number`,
    )
    .all(sessionId) as SessionLinkedTargetRow[];
}

// Attribute a dev session to a PR row by recording it in the generalized session_links bridge
// (kind='dev'). Usage attribution and retro resolve the PR's implementation session from there.
// The PR's related-sessions list accumulates every dev session that worked it; the *primary* anchor
// is the latest-linked one (primaryDevSessionForPull) — a fresh PR re-entry re-links the session
// it is about to spawn, so latest-writer-wins still holds. As of #316 there is no denormalized
// pulls.session_id to keep in sync; the link is the single source of truth.
export function setPullSession(issueId: number, sessionId: string) {
  setSessionKind(sessionId, "dev");
  linkSession(sessionId, issueId);
}

// The PR's implementation-session anchor (#316): the latest kind='dev' session linked to the row.
// Derived from session_links — the single source of truth since pulls.session_id was dropped. `lh
// dev` links each dev session it opens/re-enters (createPull / setPullSession), and the newest link
// wins (ORDER BY created_at DESC, rowid DESC), matching the old latest-writer-wins pulls.session_id.
// Returns the session id, or null when the PR has no dev session linked.
export function primaryDevSessionForPull(issueId: number): string | null {
  const row = db
    .query(
      `SELECT l.session_id AS id
       FROM session_links l
       JOIN agent_sessions s ON s.id = l.session_id
       WHERE l.issue_id = ? AND s.kind = 'dev'
       ORDER BY l.created_at DESC, l.rowid DESC
       LIMIT 1`,
    )
    .get(issueId) as { id: string } | null;
  return row?.id ?? null;
}

export function pullAgentSummary(issueId: number): PullAgentSummary | null {
  const sessionId = primaryDevSessionForPull(issueId);
  if (!sessionId) return null;
  const session = getAgentSession(sessionId);
  if (!session) return null;
  const usageModels = listSessionUsage(sessionId).map((row) => row.model);
  return {
    agent: session.agent,
    runtime: session.runtime,
    models:
      usageModels.length > 0
        ? usageModels
        : session.model
          ? [session.model]
          : [],
  };
}

export function authorFromSession(
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  const s = getAgentSession(sessionId);
  if (!s) return null;
  return s.name || s.agent;
}
