// Shared coding-agent presentation constants (#637). Extracted from settings-page.tsx so the
// issue-detail Build dropdown (#637) and the Settings screen (#610) offer the same agent labels
// and model picklist without duplicating the lists.

import type { CodingAgent } from "@/api/types";

// Human-readable agent names for pickers.
export const CODING_AGENT_LABELS: Record<CodingAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

// Suggested models per agent (#610), shown as a picklist for people who care about exact model
// versions. Static — no dynamic fetch of available models (out of scope, #594). Saved values outside
// this list are injected into the dropdowns so existing config stays visible instead of jumping to a
// suggested value.
export const MODEL_SUGGESTIONS: Record<CodingAgent, string[]> = {
  "claude-code": [
    "opus",
    "sonnet",
    "haiku",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
  ],
  codex: [
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ],
};

// Reasoning-effort levels offered per agent for the Settings screen's model+effort picker
// (#682). claude-code's levels mirror the `claude --effort` CLI flag; codex's mirror the
// `model_reasoning_effort` config values its underlying models accept. Static, like
// MODEL_SUGGESTIONS above — no dynamic fetch of what a given model actually supports.
export const EFFORT_SUGGESTIONS: Record<CodingAgent, string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high"],
};
