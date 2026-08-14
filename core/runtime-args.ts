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
import { stripVTControlCharacters } from "node:util";
import { type CodingAgent, RUNTIMES } from "./runtimes.ts";

// Strip ANSI/VT control sequences and any remaining C0/C1 control bytes from a value rendered into
// launch argv/output. The spawn command line a human reads before launch is a safety artifact; a
// value sourced from unvalidated repo/issue data (a model name, a session title) must not be able to
// forge or hide it. Shared by every argv value that reaches terminal output — cli/dev.ts's launch
// summary imports this same function so the sanitization can't drift.
export function display(v: string): string {
  return stripVTControlCharacters(v).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

// Every new agent launch runs in auto mode, using the runtime registry's approval-bypass argv.
export function runtimeApprovalArgs(runtime: CodingAgent): string[] {
  return [...RUNTIMES[runtime].autoApproveArgs];
}

// Non-Claude runtimes take no system-prompt flag, so the rendered contract is folded into the positional
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

// Everything a launch needs to build its flag argv. Split from the positional prompt below because
// a herdr launch resolves the two at different times: the flags go straight onto the command line it
// types into the pane, while the prompt is written to a file the same line reads back.
export interface RuntimeFlagsInput {
  runtime: CodingAgent;
  // `--model <name>` for every runtime (sanitized; omitted when empty).
  model?: string;
  // Reasoning effort. claude: `--effort <level>`; codex: `-c model_reasoning_effort=<level>`;
  // grok/opencode ignore it: grok has no verified effort flag; OpenCode's `--variant` exists only on
  // the `opencode run` command, not on the interactive TUI that
  // every LoopHub launch path uses (passing it makes the TUI print help and exit 1).
  effort?: string;
  // claude-only: `--session-id <id>`. Other runtimes correlate through their transcript metadata.
  sessionId?: string;
  // claude-only: `--name <name>` (terminal/session-picker title, sanitized).
  sessionName?: string;
  // claude-only: `--settings <json>` (inline managed-settings sandbox); its presence also implies auto.
  managedSettings?: string;
  // claude-only: `--append-system-prompt-file <path>`. codex/grok fold `systemPrompt` in instead.
  systemPromptFile?: string;
}

export interface RuntimeArgsInput extends RuntimeFlagsInput {
  // non-Claude only: rendered system prompt folded into the positional prompt. Ignored by claude.
  systemPrompt?: string;
  // The trailing positional the runtime receives (a slash command or the user prompt).
  prompt: string;
}

// The positional prompt a launch delivers, resolved per runtime: codex/grok take no system-prompt
// flag, so the rendered contract is folded in here; claude delivers it out of band via
// --append-system-prompt-file and its positional is the user prompt alone.
export function runtimePrompt(input: RuntimeArgsInput): string {
  return input.runtime === "claude-code"
    ? input.prompt
    : foldPrompt(input.systemPrompt, input.prompt);
}

// Build the flag argv (without the runtime binary and without the trailing positional prompt) for
// one launch. Split out from buildRuntimeArgs for the herdr launches, which put the flags on the
// command line they type into the pane and append the prompt as a `"$(cat …)"` positional read back
// from a file rather than as a literal token (see agentCommandLine).
export function buildRuntimeFlags(input: RuntimeFlagsInput): string[] {
  const { runtime } = input;
  if (runtime === "codex") {
    const args = runtimeApprovalArgs(runtime);
    args.push(...modelFlag(input.model));
    if (input.effort) {
      const e = display(input.effort).trim();
      if (e) args.push("-c", `model_reasoning_effort=${e}`);
    }
    return args;
  }
  if (runtime === "opencode") {
    // OpenCode TUI: `--auto`, `--model`, and `--prompt <text>`. The bare positional is a project
    // path, not a message — so the prompt is a flag value. End with `--prompt` so
    // agentCommandLine's `"$(cat …)"` becomes that value (same shape as buildRuntimeArgs, which
    // appends the prompt text after these flags).
    //
    // Do not forward Settings effort as `--variant`: that flag is accepted only by `opencode run`
    // (1.18.13). The interactive TUI rejects unknown options by printing help and exiting 1, which
    // is the same class of immediate pane death as grok's old rejected `--force` (#1540).
    const args = runtimeApprovalArgs(runtime);
    args.push(...modelFlag(input.model));
    args.push("--prompt");
    return args;
  }
  if (runtime === "grok") {
    const args = runtimeApprovalArgs(runtime);
    args.push(...modelFlag(input.model));
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
  args.push(...runtimeApprovalArgs(runtime));
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
  return args;
}

// Build the full argv (without the runtime binary) for one launch: the flags above followed by the
// trailing positional prompt. The per-runtime ordering is preserved exactly as the previous
// hand-written builders produced it, so every existing launch path emits byte-identical argv.
export function buildRuntimeArgs(input: RuntimeArgsInput): string[] {
  const flags = buildRuntimeFlags(input);
  return [...flags, runtimePrompt(input)];
}
