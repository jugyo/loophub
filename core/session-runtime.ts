import { RUNTIMES } from "./runtimes.ts";

// Historical agent labels for development sessions registered before the runtime column existed.
// Their launcher always used Claude Code, so the fallback keeps those rows attributable after the
// explicit runtime became the source of truth.
export const LH_BUILD_SESSION_AGENT = "lh-build";
export const LEGACY_LH_DEV_SESSION_AGENT = "lh-dev";

// The agent label and session kind used by the interactive issue-creation flow.
export const LH_ISSUE_CREATE_SESSION_AGENT = "issue-create";
export const SESSION_KIND_ISSUE_CREATE = "issue-create";

// Env vars used to correlate an issue-creation agent with the issue and Herdr pane it creates.
export const ENV_ISSUE_CREATE_SESSION = "LOOPHUB_ISSUE_CREATE_SESSION";
export const ENV_ISSUE_CREATE_HERDR_LAUNCH =
  "LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH";

export const RUNTIME_CLAUDE_CODE = RUNTIMES["claude-code"].id;
export const RUNTIME_CODEX = RUNTIMES.codex.id;
export const RUNTIME_GROK = RUNTIMES.grok.id;
export const RUNTIME_CURSOR = RUNTIMES.cursor.id;
export const RUNTIME_OPENCODE = RUNTIMES.opencode.id;

// Claude accepts UUIDs for caller-supplied session ids. Validate them before they become argv so a
// flag-like value cannot be interpreted as another option.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isClaudeSessionId(id: string | null | undefined): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

// Prefer the persisted runtime. Runtime-less rows from the historical build/dev launchers retain
// their Claude Code identity so existing usage remains discoverable and attributable.
export function sessionRuntime(
  row: { runtime?: string | null; agent?: string | null } | null | undefined,
): string | null {
  if (!row) return null;
  if (row.runtime) return row.runtime;
  if (
    row.agent === LH_BUILD_SESSION_AGENT ||
    row.agent === LEGACY_LH_DEV_SESSION_AGENT
  )
    return RUNTIME_CLAUDE_CODE;
  return null;
}
