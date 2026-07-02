import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  normalizeTerminalLaunchBackend,
  type TerminalLaunchBackend,
} from "./terminal-launch.ts";

// Known config.json fields (#474). Fields are optional — any subset may be present, and
// unrecognized fields written by a future version must round-trip through updateConfig
// untouched (it merges into the raw parsed object, not this typed shape).
export interface GlobalConfig {
  worktreeRoot?: string;
  url?: string;
  terminalLaunchBackend?: TerminalLaunchBackend;
  // Whether the Build button (issue row / issue detail) launches `lh dev` with auto mode
  // (--auto for Claude Code, an equivalent flag for Codex). Default off (#499).
  autoModeOnBuild?: boolean;
}

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
  if (process.env.LOOPHUB_WORKTREE_ROOT)
    return process.env.LOOPHUB_WORKTREE_ROOT;
  try {
    const cfg = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    if (cfg.worktreeRoot) return cfg.worktreeRoot;
  } catch {}
  return join(configDir(), "worktrees");
}

// Worker consumer cursor file (see core/worker-cursor.ts). Override via LOOPHUB_WORKER_CURSOR;
// default `$LOOPHUB_HOME/worker-cursor.json`. Kept out of the DB on purpose.
export function workerCursorPath(): string {
  return (
    process.env.LOOPHUB_WORKER_CURSOR ?? join(configDir(), "worker-cursor.json")
  );
}

// Directory for workflow run logs: `$LOOPHUB_HOME/logs/<owner>/<repo>/<event>-<id>.log`.
export function logsDir(): string {
  return join(configDir(), "logs");
}

export function baseUrl(): string {
  if (process.env.LOOPHUB_URL) return process.env.LOOPHUB_URL;
  try {
    const cfg = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    if (cfg.url) return cfg.url;
  } catch {}
  return `http://localhost:${port()}`;
}

/** Web UI path (no hash — safe for Cursor links that over-escape `#`). */
export function uiUrl(path: string): string {
  const p = path.replace(/^\/+/, "");
  return p ? `${baseUrl()}/${p}` : baseUrl();
}

export function terminalLaunchBackend(): TerminalLaunchBackend {
  if (process.env.LOOPHUB_TERMINAL_LAUNCH_BACKEND) {
    return normalizeTerminalLaunchBackend(
      process.env.LOOPHUB_TERMINAL_LAUNCH_BACKEND,
    );
  }
  try {
    const cfg = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    return normalizeTerminalLaunchBackend(cfg.terminalLaunchBackend);
  } catch {}
  return "builtin";
}

// Whether the Build button should launch `lh dev` with auto mode (#499). Default false.
export function autoModeOnBuild(): boolean {
  try {
    const cfg = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    return cfg.autoModeOnBuild === true;
  } catch {}
  return false;
}

function configPath(): string {
  return join(configDir(), "config.json");
}

/** Raw config.json contents, or {} when the file is absent/unreadable/malformed. */
function readConfigFile(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into config.json, preserving every other field (known or not), and persist
 * atomically (temp file + rename, mirroring core/worker-cursor.ts) so a crash mid-write never
 * leaves a truncated file. Returns the merged config.
 *
 * `undefined`-valued keys in `patch` are dropped rather than merged: an object spread copies an
 * own property even when its value is `undefined`, which would otherwise clobber an existing
 * field and then vanish on JSON.stringify — silently erasing it instead of leaving it untouched
 * (a caller that omits an optional field must not wipe it, e.g. an RPC param the client left out).
 */
export function updateConfig(patch: Partial<GlobalConfig>): GlobalConfig {
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  const merged = { ...readConfigFile(), ...definedPatch };
  mkdirSync(configDir(), { recursive: true });
  const path = configPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, path);
  return merged as GlobalConfig;
}
