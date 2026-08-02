import { db, now } from "../db.ts";

export interface AgentExecutionTargetRow {
  session_id: string;
  provider: string;
  target_id: string;
  context: string | null;
  created_at: string;
  updated_at: string;
}

export function registerAgentExecutionTarget(input: {
  sessionId: string;
  provider: string;
  targetId: string;
  context?: string | null;
}): AgentExecutionTargetRow {
  const t = now();
  db.run(
    `INSERT INTO agent_execution_targets
       (session_id, provider, target_id, context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       provider = excluded.provider,
       target_id = excluded.target_id,
       context = excluded.context,
       updated_at = excluded.updated_at`,
    [
      input.sessionId,
      input.provider,
      input.targetId,
      input.context ?? null,
      t,
      t,
    ],
  );
  return getAgentExecutionTarget(input.sessionId) as AgentExecutionTargetRow;
}

export function getAgentExecutionTarget(
  sessionId: string,
): AgentExecutionTargetRow | null {
  return db
    .query("SELECT * FROM agent_execution_targets WHERE session_id = ?")
    .get(sessionId) as AgentExecutionTargetRow | null;
}
