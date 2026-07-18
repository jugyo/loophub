// Registry-driven runtime argv assembly — the single place the per-runtime launch *posture* lives.
//
// Previously every launch path re-implemented the same per-runtime argv shape independently
// (cli/dev.ts's interactive builders, `lh workflow`'s parent/step launch, and
// core/terminal/terminal-launch.ts's herdr command builders), cross-referencing each other with
// "mirror cli/dev.ts buildCodexArgs" comments — a standing drift risk (#1636). The runtime-specific
// facts already collapsed into core/runtimes.ts (#1588/#1589: the auto-approve flag, labels); this
// module collapses the remaining *assembly* so adding a runtime or changing a posture is one edit.
//
// The call sites differ in real ways — interactive `codex` vs the scheduled `codex exec`,
// `--session-id` / `--append-system-prompt-file` are claude-only, `effort` is a codex knob — so those
// differences are expressed as options here rather than as runtime-id branches at the caller.
//
// This module is node-dependent (buildCodexSandboxArgs → configDir), so it stays in core rather than
// core/runtimes.ts (which is deliberately node-free for the web bundle).

import { stripVTControlCharacters } from "node:util";
import { type CodingAgent, RUNTIMES } from "./runtimes.ts";
import { buildCodexSandboxArgs } from "./terminal/codex-launch.ts";

// Strip ANSI/VT control sequences and any remaining C0/C1 control bytes from a value rendered into
// launch argv/output. The spawn command line a human reads before launch is a safety artifact; a
// value sourced from unvalidated repo/issue data (a model name, a session title) must not be able to
// forge or hide it. Shared by every argv value that reaches terminal output — cli/dev.ts's launch
// summary imports this same function so the sanitization can't drift.
export function display(v: string): string {
  return stripVTControlCharacters(v).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

// The approval / sandbox argv fragment for a runtime, given whether the launch runs in auto mode
// (skip approval prompts, run tools without asking). This is the one place the per-runtime posture
// that used to be duplicated as `auto ? autoApproveArgs : …` lives:
//   - auto:      every runtime appends its registry autoApproveArgs (#1588).
//   - non-auto:  codex falls back to its workspace-write sandbox (granting `loopHubHome` — default
//                configDir() — as a writable root); claude and grok add nothing.
export function runtimeApprovalArgs(input: {
  runtime: CodingAgent;
  auto?: boolean;
  loopHubHome?: string;
}): string[] {
  if (input.auto) return [...RUNTIMES[input.runtime].autoApproveArgs];
  return input.runtime === "codex"
    ? buildCodexSandboxArgs(input.loopHubHome)
    : [];
}

// codex/grok take no system-prompt flag, so the rendered contract is folded into the positional
// prompt; claude delivers it out of band via --append-system-prompt-file instead (see buildRuntimeArgs).
function foldPrompt(systemPrompt: string | undefined, prompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

// `--model <name>` for every runtime, sanitized and dropped when empty. No name validation — an
// unknown name is the runtime CLI's error to raise (#594).
function modelFlag(model: string | undefined): string[] {
  if (!model) return [];
  const m = display(model).trim();
  return m ? ["--model", m] : [];
}

export interface RuntimeArgsInput {
  runtime: CodingAgent;
  // Opt into auto mode (skip approval prompts). For claude it is also implied by managedSettings.
  auto?: boolean;
  // codex non-auto sandbox writable root (defaults to configDir()); ignored by claude/grok.
  loopHubHome?: string;
  // `--model <name>` for every runtime (sanitized; omitted when empty).
  model?: string;
  // Reasoning effort. claude: `--effort <level>`; codex: `-c model_reasoning_effort=<level>`; grok
  // has no verified effort flag, so it is ignored.
  effort?: string;
  // claude-only: `--session-id <id>`. codex/grok have no equivalent and correlate via env instead.
  sessionId?: string;
  // claude-only: `--name <name>` (terminal/session-picker title, sanitized).
  sessionName?: string;
  // claude-only: `--settings <json>` (inline managed-settings sandbox); its presence also implies auto.
  managedSettings?: string;
  // claude-only: `--append-system-prompt-file <path>`. codex/grok fold `systemPrompt` in instead.
  systemPromptFile?: string;
  // codex/grok only: rendered system prompt folded into the positional prompt. Ignored by claude.
  systemPrompt?: string;
  // The trailing positional the runtime receives (a slash command or the user prompt).
  prompt: string;
}

// Build the argv (without the runtime binary) for one launch. The per-runtime ordering is preserved
// exactly as the previous hand-written builders produced it, so every existing launch path emits
// byte-identical argv.
export function buildRuntimeArgs(input: RuntimeArgsInput): string[] {
  const { runtime } = input;
  if (runtime === "codex") {
    const args = runtimeApprovalArgs(input);
    args.push(...modelFlag(input.model));
    if (input.effort) {
      const e = display(input.effort).trim();
      if (e) args.push("-c", `model_reasoning_effort=${e}`);
    }
    args.push(foldPrompt(input.systemPrompt, input.prompt));
    return args;
  }
  if (runtime === "grok") {
    const args = runtimeApprovalArgs(input);
    args.push(...modelFlag(input.model));
    args.push(foldPrompt(input.systemPrompt, input.prompt));
    return args;
  }
  // claude-code
  const args: string[] = [];
  if (input.sessionId) args.push("--session-id", input.sessionId);
  args.push(...modelFlag(input.model));
  if (input.effort) {
    const e = display(input.effort).trim();
    if (e) args.push("--effort", e);
  }
  // Auto mode is requested explicitly (--auto) or implied by the sandbox managed-settings.
  const auto = !!(input.auto || input.managedSettings);
  args.push(...runtimeApprovalArgs({ runtime, auto }));
  if (input.sessionName) {
    const name = display(input.sessionName).trim();
    if (name) args.push("--name", name);
  }
  if (input.managedSettings) {
    args.push("--settings", input.managedSettings);
  }
  if (input.systemPromptFile) {
    args.push("--append-system-prompt-file", input.systemPromptFile);
  }
  args.push(input.prompt);
  return args;
}
