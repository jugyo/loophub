import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type EffectiveAgentConfig,
  effectiveRepoAgentConfig,
  type RepoAgentSetting,
} from "./repo-agent-config.ts";
import {
  CODING_AGENTS,
  type CodingAgent,
  normalizeCodingAgent,
  RUNTIMES,
} from "./runtimes.ts";

// Which coding agent agent launches use by default (#516). The type + ordered list + normalizer are
// defined in the single runtime registry (core/runtimes.ts); re-exported here so existing importers
// of `CodingAgent` / `CODING_AGENTS` / `normalizeCodingAgent` from core/config.ts are unchanged.
export { CODING_AGENTS, type CodingAgent, normalizeCodingAgent };

// Per-agent settings (#593). Kept as its own shape (rather than flattening fields onto
// GlobalConfig) so a future setting can be added per-agent without another top-level field.
export interface AgentConfig {
  // Model this agent launches with when no explicit --model is passed (#594).
  // Falls back to DEFAULT_AGENT_MODEL when unset.
  defaultModel?: string;
  // Reasoning effort paired with defaultModel in the Settings screen (#682). Falls back to
  // DEFAULT_AGENT_EFFORT when unset. Stored for Settings; launch paths that honor it read via
  // agentEffort().
  defaultEffort?: string;
}

// Default per-agent model (#594) used by agentModel() when config.json has no override, and default
// per-agent effort (#682) used by agentEffort(). Derived from the runtime registry (core/runtimes.ts)
// so the values live in one place; the `Record<CodingAgent, string>` shape is preserved for callers.
export const DEFAULT_AGENT_MODEL: Record<CodingAgent, string> =
  Object.fromEntries(
    CODING_AGENTS.map((a) => [a, RUNTIMES[a].defaultModel]),
  ) as Record<CodingAgent, string>;

export const DEFAULT_AGENT_EFFORT: Record<CodingAgent, string> =
  Object.fromEntries(
    CODING_AGENTS.map((a) => [a, RUNTIMES[a].defaultEffort]),
  ) as Record<CodingAgent, string>;

// Default top-level cumulative cost (USD) at which a development agent is stopped.
export const DEFAULT_DEV_COST_LIMIT_USD = 10;

// Default interval between `workflow_run.cost_exceeded` re-emissions for the same run and limit.
export const DEFAULT_COST_REEMIT_MS = 300_000;

// Whether the Web UI rings a bell when a new notification arrives (#2508). On unless turned off.
export const DEFAULT_NOTIFICATION_SOUND = true;

// Known config.json fields (#474). Fields are optional — any subset may be present, and
// unrecognized fields written by a future version must round-trip through updateConfig
// untouched (it merges into the raw parsed object, not this typed shape).
export interface GlobalConfig {
  worktreeRoot?: string;
  url?: string;
  // Per-agent settings, keyed by CodingAgent (#593). Absent entries default to unset (off).
  agents?: Partial<Record<CodingAgent, AgentConfig>>;
  // Default coding agent used when neither --claude-code nor --codex is passed (#516).
  // Default "claude-code".
  codingAgent?: CodingAgent;
  // Per-task over-budget stop threshold for implementation agents. Default $10.
  devCostLimitUsd?: number;
  // Whether the Web UI plays a sound for new notifications (#2508). Default true.
  notificationSound?: boolean;
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

// Root for PR/attempt worktrees. Override via LOOPHUB_WORKTREE_ROOT or config.json
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

// Model launches of `agent` use when --model isn't passed explicitly (#594). Falls back
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

// Resolve a repo's raw Coding agent override (#1532) against the live application defaults
// (codingAgent() / agentModel() / agentEffort()). The binding lives here — where the app defaults
// live — so callers pass only the repo's stored setting and the pure resolver stays config-free.
export function resolveEffectiveAgentConfig(
  setting: RepoAgentSetting,
): EffectiveAgentConfig {
  return effectiveRepoAgentConfig(setting, {
    runtime: codingAgent(),
    model: agentModel,
    effort: agentEffort,
  });
}

// Per-task over-budget stop threshold for implementation agents (#1027). A malformed
// persisted value is ignored rather than disabling the guard.
export function devCostLimitUsd(): number {
  try {
    const cfg: GlobalConfig = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    const configured = cfg.devCostLimitUsd;
    if (
      typeof configured === "number" &&
      Number.isFinite(configured) &&
      configured > 0
    ) {
      return configured;
    }
  } catch {}
  return DEFAULT_DEV_COST_LIMIT_USD;
}

// Whether the Web UI plays a sound for new notifications (#2508). A non-boolean persisted value is
// ignored rather than silencing the bell.
export function notificationSound(): boolean {
  try {
    const cfg: GlobalConfig = JSON.parse(
      readFileSync(join(configDir(), "config.json"), "utf8"),
    );
    if (typeof cfg.notificationSound === "boolean")
      return cfg.notificationSound;
  } catch {}
  return DEFAULT_NOTIFICATION_SOUND;
}

// How long a `workflow_run.cost_exceeded` event suppresses the next one for the same run and
// limit (#1844). Detection re-emits while the run stays over its limit without a hold, so a parent
// that stopped between wake and `cost-hold` still receives the interrupt on a later wake. Longer
// than the time a live parent needs to reach `cost-hold` (~1 min), short enough to bound the spend
// a stopped parent lets through. Override via LOOPHUB_COST_REEMIT_MS; 0 re-emits on every sweep.
export function costReemitMs(): number {
  const raw = process.env.LOOPHUB_COST_REEMIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_COST_REEMIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_COST_REEMIT_MS;
  return parsed;
}

// The default coding agent when neither --claude-code nor --codex is passed (#516).
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

export function updateDevCostLimitUsd(limitUsd: number): GlobalConfig {
  return updateConfig({ devCostLimitUsd: limitUsd });
}

export function updateNotificationSound(enabled: boolean): GlobalConfig {
  return updateConfig({ notificationSound: enabled });
}
