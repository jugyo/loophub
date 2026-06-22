import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Read env at call time so parallel test files can set LOOPHUB_HOME/LOOPHUB_DB
// before db.ts is first imported (import-time consts froze the wrong path).
export function port(): number {
  return Number(process.env.LOOPHUB_PORT ?? 8730);
}

export function configDir(): string {
  return process.env.LOOPHUB_HOME ?? join(homedir(), ".loophub");
}

export function dbPath(): string {
  return process.env.LOOPHUB_DB ?? join(configDir(), "loophub.db");
}

// Root for `lh dev` worktrees. Override via LOOPHUB_WORKTREE_ROOT or config.json
// `worktreeRoot`; default `$LOOPHUB_HOME/worktrees`.
export function worktreeRoot(): string {
  if (process.env.LOOPHUB_WORKTREE_ROOT) return process.env.LOOPHUB_WORKTREE_ROOT;
  try {
    const cfg = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));
    if (cfg.worktreeRoot) return cfg.worktreeRoot;
  } catch {}
  return join(configDir(), "worktrees");
}

// Worker consumer cursor file (see core/worker-cursor.ts). Override via LOOPHUB_WORKER_CURSOR;
// default `$LOOPHUB_HOME/worker-cursor.json`. Kept out of the DB on purpose.
export function workerCursorPath(): string {
  return process.env.LOOPHUB_WORKER_CURSOR ?? join(configDir(), "worker-cursor.json");
}

// Directory for workflow run logs: `$LOOPHUB_HOME/logs/<owner>/<repo>/<event>-<id>.log`.
export function logsDir(): string {
  return join(configDir(), "logs");
}

export function baseUrl(): string {
  if (process.env.LOOPHUB_URL) return process.env.LOOPHUB_URL;
  try {
    const cfg = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));
    if (cfg.url) return cfg.url;
  } catch {}
  return `http://localhost:${port()}`;
}

/** Web UI path (no hash — safe for Cursor links that over-escape `#`). */
export function uiUrl(path: string): string {
  const p = path.replace(/^\/+/, "");
  return p ? `${baseUrl()}/${p}` : baseUrl();
}
