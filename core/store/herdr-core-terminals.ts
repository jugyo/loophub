import { db, now } from "../db.ts";

// LoopHub's record of each herdr-core terminal, kept current by the worker's `hc events`
// subscription. See the table's migration for the column semantics.

export interface HerdrCoreTerminalState {
  address: string;
  repo_id: number;
  role: string | null;
  pr_number: number | null;
  run_id: number | null;
  seq: number | null;
  state: string;
  status: string | null;
  turn: number;
  exit_code: number | null;
  reason: string | null;
}

export type HerdrCoreTerminalRow = HerdrCoreTerminalState & {
  updated_at: string;
};

export function getHerdrCoreTerminal(
  address: string,
): HerdrCoreTerminalRow | null {
  return db
    .query("SELECT * FROM herdr_core_terminals WHERE address = ?")
    .get(address) as HerdrCoreTerminalRow | null;
}

export function listHerdrCoreTerminalRows(
  repoId: number,
): HerdrCoreTerminalRow[] {
  return db
    .query("SELECT * FROM herdr_core_terminals WHERE repo_id = ?")
    .all(repoId) as HerdrCoreTerminalRow[];
}

export function upsertHerdrCoreTerminal(row: HerdrCoreTerminalState): void {
  db.query(
    `INSERT INTO herdr_core_terminals
       (address, repo_id, role, pr_number, run_id, seq, state, status, turn, exit_code, reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       repo_id = excluded.repo_id,
       role = excluded.role,
       pr_number = excluded.pr_number,
       run_id = excluded.run_id,
       seq = excluded.seq,
       state = excluded.state,
       status = excluded.status,
       turn = excluded.turn,
       exit_code = excluded.exit_code,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).run(
    row.address,
    row.repo_id,
    row.role,
    row.pr_number,
    row.run_id,
    row.seq,
    row.state,
    row.status,
    row.turn,
    row.exit_code,
    row.reason,
    now(),
  );
}

export function deleteHerdrCoreTerminal(address: string): void {
  db.query("DELETE FROM herdr_core_terminals WHERE address = ?").run(address);
}
