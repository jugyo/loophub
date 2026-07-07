import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Which coding agent `lh build` launches by default (#516). Mirrors the `DevRuntime` values
// cli/dev.ts's --claude-code / --codex flags select between.
export type CodingAgent = "claude-code" | "codex";

export const CODING_AGENTS: readonly CodingAgent[] = ["claude-code", "codex"];

// Per-agent settings (#593). Kept as its own shape (rather than flattening fields onto
// GlobalConfig) so a future setting can be added per-agent without another top-level field.
export interface AgentConfig {
  // Whether the Build button (issue row / issue detail) launches this agent with auto mode
  // (--auto for Claude Code, an equivalent flag for Codex). Default off (#499, #593).
  autoModeOnBuild?: boolean;
  // Model this agent launches with when `lh build --model` isn't passed explicitly (#594).
  // Falls back to DEFAULT_AGENT_MODEL when unset.
  defaultModel?: string;
  // Reasoning effort paired with defaultModel in the Settings screen (#682). Falls back to
  // DEFAULT_AGENT_EFFORT when unset. Not yet wired into `lh build`'s spawn args — the Settings
  // screen only stores the model+effort pair for now.
  defaultEffort?: string;
}

// Default per-agent model (#594) used by agentModel() when config.json has no override.
// claude-code accepts the bare "opus" alias (resolved by the claude CLI itself); codex has no
// alias support so its default is the full model name.
export const DEFAULT_AGENT_MODEL: Record<CodingAgent, string> = {
  "claude-code": "opus",
  codex: "gpt-5.5",
};

// Default per-agent effort (#682) used by agentEffort() when config.json has no override.
export const DEFAULT_AGENT_EFFORT: Record<CodingAgent, string> = {
  "claude-code": "medium",
  codex: "medium",
};

// Known config.json fields (#474). Fields are optional — any subset may be present, and
// unrecognized fields written by a future version must round-trip through updateConfig
// untouched (it merges into the raw parsed object, not this typed shape).
export interface GlobalConfig {
  worktreeRoot?: string;
  url?: string;
  // Per-agent settings, keyed by CodingAgent (#593). Absent entries default to unset (off).
  agents?: Partial<Record<CodingAgent, AgentConfig>>;
  // Default coding agent `lh build` launches when neither --claude-code nor --codex is passed
  // (#516). Default "claude-code".
  codingAgent?: CodingAgent;
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

// Root for `lh build` worktrees. Override via LOOPHUB_WORKTREE_ROOT or config.json
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

// Whether the Build button should launch `agent` with auto mode (#499, #593). Default false.
export function autoModeOnBuild(agent: CodingAgent): boolean {
  try {
    const cfg: GlobalConfig = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    return cfg.agents?.[agent]?.autoModeOnBuild === true;
  } catch {}
  return false;
}

// Model `lh build` launches `agent` with when --model isn't passed explicitly (#594). Falls back
// to DEFAULT_AGENT_MODEL when config.json has no override for this agent.
export function agentModel(agent: CodingAgent): string {
  try {
    const cfg: GlobalConfig = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    const configured = cfg.agents?.[agent]?.defaultModel?.trim();
    if (configured) return configured;
  } catch {}
  return DEFAULT_AGENT_MODEL[agent];
}

// Effort paired with agentModel() (#682). Falls back to DEFAULT_AGENT_EFFORT when config.json
// has no override for this agent.
export function agentEffort(agent: CodingAgent): string {
  try {
    const cfg: GlobalConfig = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    const configured = cfg.agents?.[agent]?.defaultEffort?.trim();
    if (configured) return configured;
  } catch {}
  return DEFAULT_AGENT_EFFORT[agent];
}

export function normalizeCodingAgent(value: unknown): CodingAgent {
  return value === "codex" ? "codex" : "claude-code";
}

// The coding agent `lh build` launches when neither --claude-code nor --codex is passed (#516).
// Default "claude-code".
export function codingAgent(): CodingAgent {
  try {
    const cfg = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    return normalizeCodingAgent(cfg.codingAgent);
  } catch {}
  return "claude-code";
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

// Set a single agent's autoModeOnBuild without disturbing other agents' settings (#593).
// updateConfig replaces `agents` wholesale, so the existing map is read and merged here first.
export function updateAgentAutoModeOnBuild(
  agent: CodingAgent,
  value: boolean,
): GlobalConfig {
  const current = readConfigFile() as GlobalConfig;
  return updateConfig({
    agents: {
      ...current.agents,
      [agent]: { ...current.agents?.[agent], autoModeOnBuild: value },
    },
  });
}

// Set a single agent's defaultModel without disturbing other agents' settings (#594).
export function updateAgentDefaultModel(
  agent: CodingAgent,
  model: string,
): GlobalConfig {
  const current = readConfigFile() as GlobalConfig;
  return updateConfig({
    agents: {
      ...current.agents,
      [agent]: { ...current.agents?.[agent], defaultModel: model },
    },
  });
}

// Set a single agent's defaultEffort without disturbing other agents' settings (#682).
export function updateAgentDefaultEffort(
  agent: CodingAgent,
  effort: string,
): GlobalConfig {
  const current = readConfigFile() as GlobalConfig;
  return updateConfig({
    agents: {
      ...current.agents,
      [agent]: { ...current.agents?.[agent], defaultEffort: effort },
    },
  });
}
