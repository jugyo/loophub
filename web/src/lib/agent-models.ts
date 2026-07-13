// Shared coding-agent presentation constants (#637). The labels and the model/effort picklists are
// derived from the single runtime registry (core/runtimes.ts) — a node-free core module the web can
// import directly, the same pattern as core/workflow/example-prompts.ts — so the Settings screen
// (#610), the issue-detail Build dropdown (#637), and the per-agent defaults all read one source
// instead of duplicating the lists here.

import type { CodingAgent } from "@/api/types";
import { CODING_AGENTS, RUNTIMES } from "../../../core/runtimes.ts";

// Human-readable agent names for pickers.
export const CODING_AGENT_LABELS: Record<CodingAgent, string> =
  Object.fromEntries(
    CODING_AGENTS.map((agent) => [agent, RUNTIMES[agent].label]),
  ) as Record<CodingAgent, string>;

// Suggested models per agent (#610), shown as a picklist for people who care about exact model
// versions. Static — no dynamic fetch of available models (out of scope, #594). Saved values outside
// this list are injected into the dropdowns so existing config stays visible instead of jumping to a
// suggested value.
export const MODEL_SUGGESTIONS: Record<CodingAgent, string[]> =
  Object.fromEntries(
    CODING_AGENTS.map((agent) => [agent, RUNTIMES[agent].modelSuggestions]),
  ) as Record<CodingAgent, string[]>;

// Reasoning-effort levels offered per agent for the Settings screen's model+effort picker (#682).
// claude-code's levels mirror the `claude --effort` CLI flag; codex's mirror the
// `model_reasoning_effort` config values its underlying models accept. Static, like
// MODEL_SUGGESTIONS above — no dynamic fetch of what a given model actually supports.
export const EFFORT_SUGGESTIONS: Record<CodingAgent, string[]> =
  Object.fromEntries(
    CODING_AGENTS.map((agent) => [agent, RUNTIMES[agent].effortSuggestions]),
  ) as Record<CodingAgent, string[]>;
