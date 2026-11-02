// #2571: the terminal backend a workflow run launches its agents with. 'herdr' is the default;
// 'herdr-core' runs them through the `hc` CLI (core/herdr-core.ts). The repo setting
// (repos.terminal_backend) is copied into the run's manifest at start, so the manifest — not the
// live setting — decides an in-flight run's backend.

export type TerminalBackend = "herdr" | "herdr-core";

export const DEFAULT_TERMINAL_BACKEND: TerminalBackend = "herdr";

export function isTerminalBackend(raw: unknown): raw is TerminalBackend {
  return raw === "herdr" || raw === "herdr-core";
}

// Stored value → effective backend. NULL (never set) or an unknown value falls back to the default.
export function normalizeTerminalBackend(
  raw: string | null | undefined,
): TerminalBackend {
  return isTerminalBackend(raw) ? raw : DEFAULT_TERMINAL_BACKEND;
}
