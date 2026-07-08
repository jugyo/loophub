import { db, now } from "../db.ts";

export type InboxMessageState = "unread" | "read" | "archived" | "deleted";

export interface InboxMessageInput {
  repoId: number;
  fromJson: string;
  toJson?: string | null;
  label?: string | null;
  title: string;
  body: string;
  state?: InboxMessageState;
}

export interface InboxMessageRow {
  id: number;
  repo_id: number;
  from_json: string;
  to_json: string | null;
  label: string | null;
  title: string;
  body: string;
  state: InboxMessageState;
  created_at: string;
}

export function createInboxMessage(input: InboxMessageInput): InboxMessageRow {
  return db
    .query(
      `INSERT INTO inbox_messages
        (repo_id, from_json, to_json, label, title, body, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.repoId,
      input.fromJson,
      input.toJson ?? null,
      input.label ?? null,
      input.title,
      input.body,
      input.state ?? "unread",
      now(),
    ) as InboxMessageRow;
}

export function getInboxMessageById(id: number): InboxMessageRow | null {
  return db
    .query(`SELECT * FROM inbox_messages WHERE id = ?`)
    .get(id) as InboxMessageRow | null;
}

export function listInboxMessages(
  repoId: number,
  opts: { state?: InboxMessageState; limit?: number } = {},
): InboxMessageRow[] {
  const limit = opts.limit ?? 50;
  if (opts.state) {
    return db
      .query(
        `SELECT * FROM inbox_messages
         WHERE repo_id = ? AND state = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(repoId, opts.state, limit) as InboxMessageRow[];
  }
  return db
    .query(
      `SELECT * FROM inbox_messages
       WHERE repo_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(repoId, limit) as InboxMessageRow[];
}
