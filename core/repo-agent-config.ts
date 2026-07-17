// Pure, side-effect-free resolution for the per-repo Coding agent override (#1532): does a repo pin
// its own runtime / model / effort, or fall back to the application (config.json) defaults? Mirrors
// core/merge-mode.ts's "pinned repo setting wins, else default" structure. Kept a leaf (only the
// node-free runtime registry is imported) so it can be unit-tested without a DB/config and the app
// defaults are injected rather than read here.

import type { CodingAgent } from "./runtimes.ts";
import { isCodingAgent } from "./runtimes.ts";

// The raw per-repo override, read off the repos row. `override` is the toggle; the three values are
// the repo-specific choices, effective only while the toggle is on. A null value falls back per field.
export interface RepoAgentSetting {
  override: boolean;
  runtime: CodingAgent | null;
  model: string | null;
  effort: string | null;
}

// The resolved coding-agent config a workflow run launches with.
export interface EffectiveAgentConfig {
  runtime: CodingAgent;
  model: string;
  effort: string;
}

// The application (config.json) defaults, injected so this module stays a pure leaf. `model` /
// `effort` are functions of the runtime because their config defaults are per-agent (agentModel /
// agentEffort).
export interface AppAgentDefaults {
  runtime: CodingAgent;
  model: (runtime: CodingAgent) => string;
  effort: (runtime: CodingAgent) => string;
}

// Validate a raw stored `agent_runtime` value into a CodingAgent, or null for "unset / default".
// Any other value (legacy, typo, a runtime removed from the registry) collapses to null so the
// app default takes over rather than throwing on read.
export function normalizeRepoAgentRuntime(
  raw: string | null | undefined,
): CodingAgent | null {
  return isCodingAgent(raw) ? raw : null;
}

// Resolve a repo's raw override into its effective coding-agent config: while the toggle is on each
// field prefers the repo value, otherwise it falls back to the app default. The model / effort
// defaults follow the *effective* runtime, so pinning only the runtime still yields that runtime's
// app-default model / effort. Mirrors effectiveMergeMode (#406).
export function effectiveRepoAgentConfig(
  setting: RepoAgentSetting,
  defaults: AppAgentDefaults,
): EffectiveAgentConfig {
  const active = setting.override;
  const runtime =
    active && setting.runtime ? setting.runtime : defaults.runtime;
  const model =
    active && setting.model?.trim()
      ? setting.model.trim()
      : defaults.model(runtime);
  const effort =
    active && setting.effort?.trim()
      ? setting.effort.trim()
      : defaults.effort(runtime);
  return { runtime, model, effort };
}
