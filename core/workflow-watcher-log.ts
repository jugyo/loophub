import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logsDir } from "./config.ts";

export type WorkflowWatcherLogEntry = {
  event: "started" | "poll" | "delivered" | "failed";
  repo: string;
  run: number;
  cursor?: number;
  next_command?: string;
  error?: string;
};

function logPath(repo: string, run: number): string {
  const [owner, name] = repo.split("/");
  return join(logsDir(), "workflow-watch", owner, name, `run-${run}.log`);
}

/** Append one JSON record. Logging is best effort and never changes watcher behavior. */
export function logWorkflowWatcher(entry: WorkflowWatcherLogEntry): void {
  try {
    const path = logPath(entry.repo, entry.run);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  } catch (error) {
    console.error(
      `workflow watch: log write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
