// Single registry (SSOT) for coding runtimes: claude-code (default), codex (#458), and grok.
// Every runtime-specific fact that was previously duplicated across core/config.ts, core/resume.ts,
// cli/dev.ts, cli/args.ts, core/service/{terminal,settings}.ts, and the web (agent-models.ts /
// settings-page.tsx / linked-pull-summary.tsx / agent-sessions-page.tsx) lives here once, so adding
// a runtime is (close to) adding one entry below.
//
// This module is a leaf: it imports nothing from node or the rest of core, so the web bundle can
// import its *values* directly — the same pattern core/workflow/example-prompts.ts established. The
// argv builders (buildClaudeArgs/buildCodexArgs/buildGrokArgs) deliberately stay in cli/dev.ts, which
// is node-dependent (node:util, core/terminal/codex-launch.ts): the registry keys their dispatch by
// runtime id rather than owning the functions, keeping this module node-free.

// Which coding agent launches use. The runtime id doubles as the persisted `codingAgent`
// config value and the `runtime` recorded on a session.
export type CodingAgent = "claude-code" | "codex" | "grok";

// The runtime binary spawned for each runtime (`claude` / `codex` / `grok`).
export type RuntimeBin = "claude" | "codex" | "grok";

// One runtime's complete definition. Everything a caller needs to know about a runtime is a field
// here — no branch keyed on the id belongs anywhere else.
export interface RuntimeDefinition {
  // Runtime id (= CodingAgent value); also the key this entry is stored under in RUNTIMES.
  id: CodingAgent;
  // The binary spawned for this runtime.
  bin: RuntimeBin;
  // Human-readable label for pickers / session displays (e.g. "Claude Code").
  label: string;
  // The mutually-exclusive CLI flag that selects this runtime (`--claude-code` etc.).
  buildFlag: string;
  // Default model used when no explicit --model and no per-agent Settings override are present
  // (#594). claude-code accepts the bare "opus" alias (resolved by the claude CLI itself); codex has
  // no alias support so its default is the full model name. grok's default is xAI's coding model
  // (TENTATIVE — the exact grok model identifier is not verified against a running `grok` CLI here).
  defaultModel: string;
  // Default reasoning effort paired with defaultModel in the Settings screen (#682).
  defaultEffort: string;
  // Suggested models for the Settings picker (#610), shown for people who care about exact versions.
  // Static — no dynamic fetch of available models (out of scope, #594). Saved values outside this
  // list are still injected into the dropdown by the UI.
  modelSuggestions: string[];
  // Suggested reasoning-effort levels for the Settings model+effort picker (#682). claude-code's
  // mirror the `claude --effort` flag; codex's mirror the `model_reasoning_effort` config values.
  // grok's are TENTATIVE — grok has no verified user-facing reasoning-effort scale here.
  effortSuggestions: string[];
  // Whether `lh resume` can re-enter a session recorded with this runtime. Only claude-code is
  // resumable today (#164); codex/grok sessions are recorded but resolveRuntimeResume reports
  // unknown-runtime for them.
  resumable: boolean;
  // Whether the `--sandbox`/`--allow` managed-settings launch options apply to this runtime. Only
  // claude has that concept; codex/grok don't, and the CLI rejects the `--sandbox`/`--allow`
  // combination for them up front.
  sandboxCapable: boolean;
  // The argv fragment that opts this runtime into auto mode: skip approval prompts and run tools
  // without asking (`--auto` on the LoopHub side). Every launch path — cli/dev.ts's argv builders,
  // `lh workflow`'s parent agent, and core/terminal/terminal-launch.ts — appends this verbatim
  // instead of re-branching on the runtime id (#1588). It is only the approval flag: a runtime's
  // non-auto posture (Codex's workspace-write sandbox) and its other per-runtime launch differences
  // stay with the caller.
  autoApproveArgs: readonly string[];
}

// The registry entries, in the canonical display/enumeration order. `CODING_AGENTS` and the RUNTIMES
// lookup below both derive from this array so ordering stays consistent everywhere.
const RUNTIME_LIST: readonly RuntimeDefinition[] = [
  {
    id: "claude-code",
    bin: "claude",
    label: "Claude Code",
    buildFlag: "--claude-code",
    defaultModel: "opus",
    defaultEffort: "medium",
    modelSuggestions: [
      "opus",
      "sonnet",
      "haiku",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ],
    effortSuggestions: ["low", "medium", "high", "xhigh", "max"],
    resumable: true,
    sandboxCapable: true,
    autoApproveArgs: ["--permission-mode", "auto"],
  },
  {
    id: "codex",
    bin: "codex",
    label: "Codex",
    buildFlag: "--codex",
    defaultModel: "gpt-5.5",
    defaultEffort: "medium",
    modelSuggestions: [
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ],
    effortSuggestions: ["minimal", "low", "medium", "high"],
    resumable: false,
    sandboxCapable: false,
    // Codex's closest single flag to Claude Code's auto mode: it also drops the sandbox, so callers
    // that have a non-auto posture use buildCodexSandboxArgs() instead of this.
    autoApproveArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  {
    id: "grok",
    bin: "grok",
    label: "Grok Build",
    buildFlag: "--grok",
    defaultModel: "grok-code-fast-1",
    defaultEffort: "medium",
    modelSuggestions: [
      "grok-code-fast-1",
      "grok-4.5",
      "grok-4",
      "grok-4-fast",
      "grok-3",
    ],
    effortSuggestions: ["low", "medium", "high"],
    resumable: false,
    sandboxCapable: false,
    // Auto-approve all tool executions. The older tentative `--force` is rejected by current `grok`
    // CLIs as unknown, which made Web Start workflow (`--auto`) exit the agent pane at once (#1540).
    autoApproveArgs: ["--always-approve"],
  },
];

// Runtime id → its definition. Callers look a runtime up here instead of switching on the id.
export const RUNTIMES: Record<CodingAgent, RuntimeDefinition> =
  Object.fromEntries(RUNTIME_LIST.map((r) => [r.id, r])) as Record<
    CodingAgent,
    RuntimeDefinition
  >;

// The runtime ids in canonical order. The default runtime (Claude Code) is first.
export const CODING_AGENTS: readonly CodingAgent[] = RUNTIME_LIST.map(
  (r) => r.id,
);

export function isCodingAgent(value: unknown): value is CodingAgent {
  return typeof value === "string" && value in RUNTIMES;
}

// Coerce an arbitrary value to a runtime id, defaulting to claude-code — the historical fallback for
// an unknown/absent `codingAgent` config value (#516).
export function normalizeCodingAgent(value: unknown): CodingAgent {
  return isCodingAgent(value) ? value : "claude-code";
}

// Display label for a runtime id, falling back to the raw string for an unknown runtime so a session
// recorded under a future/unrecognized runtime still renders its id rather than a blank.
export function codingAgentLabel(runtime: string): string {
  return isCodingAgent(runtime) ? RUNTIMES[runtime].label : runtime;
}

// The human-readable list of runtime ids for usage/validation messages ("claude-code, codex, grok").
export const CODING_AGENTS_SENTENCE = CODING_AGENTS.join(", ");
