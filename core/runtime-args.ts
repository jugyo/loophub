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

// Apply the runtime registry's launch permission posture.
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
  // grok/opencode/opencode2 ignore it: grok has no verified effort flag; OpenCode's `--variant`
  // exists only on the `opencode run` command, not on the interactive TUI that
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

// OpenCode 2 reads its model from an inline JSON config in the environment rather than from a flag
// (see buildRuntimeFlags). Both `OPENCODE_CONFIG_CONTENT` (inline JSON) and `OPENCODE_CONFIG` (a
// config file path) work; the inline form is used so a launch never writes a config file into the
// worktree it runs in.
const OPENCODE_CONFIG_CONTENT = "OPENCODE_CONFIG_CONTENT";

// The environment a launch must add for the runtime to honour its resolved model. Every runtime
// except opencode2 answers with an empty object, because their model is an argv flag. An unset or
// blank model also answers empty, leaving the runtime on its own default.
//
// Note that an unknown model name here fails silently: OpenCode 2 falls back to the last-used model
// instead of erroring the way `--model` does. The Settings picker's suggestion list is what keeps
// typos out in practice.
//
// This config is read only when the TUI also gets `--auto` (v0.0.0-beta-19425). Without it the same
// environment is ignored and the TUI picks its own model, so the approval-bypass flag and the model
// travel together — see RuntimeDefinition.launchPromptNeedsSubmit.
export function runtimeLaunchEnv(input: {
  runtime: CodingAgent;
  model?: string | null;
}): Record<string, string> {
  if (input.runtime !== "opencode2") return {};
  const model = display(input.model ?? "").trim();
  if (!model) return {};
  return { [OPENCODE_CONFIG_CONTENT]: JSON.stringify({ model }) };
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
  if (runtime === "opencode" || runtime === "opencode2") {
    // OpenCode TUI: `--auto`, `--model`, and `--prompt <text>`. The bare positional is a project
    // path, not a message — so the prompt is a flag value. End with `--prompt` so
    // agentCommandLine's `"$(cat …)"` becomes that value (same shape as buildRuntimeArgs, which
    // appends the prompt text after these flags).
    //
    // Do not forward Settings effort as `--variant`: that flag is accepted only by `opencode run`
    // (1.18.13). The interactive TUI rejects unknown options by printing help and exiting 1, which
    // is the same class of immediate pane death as grok's old rejected `--force` (#1540).
    //
    // OpenCode 2's default TUI has no `--model` at all (`Unrecognized flag: --model`, exit 1;
    // verified against v0.0.0-beta-19425), so its model travels in the launch environment instead —
    // see runtimeLaunchEnv. That environment only reaches the model resolution when the launch runs
    // its own server: without `--standalone` the TUI attaches to the shared `opencode2 serve
    // --service` process, which resolved its config at its own startup and silently keeps whatever
    // model it already had. `--standalone` is a documented root flag, so it is safe on the TUI.
    const args = runtimeApprovalArgs(runtime);
    if (runtime === "opencode") args.push(...modelFlag(input.model));
    else args.push("--standalone");
    args.push("--prompt");
    return args;
  }
  if (runtime === "grok") {
    const args = runtimeApprovalArgs(runtime);
    args.push(...modelFlag(input.model));
    return args;
  }
  if (runtime === "agy") {
    const args = runtimeApprovalArgs(runtime);
    args.push(...modelFlag(input.model));
    if (input.effort) {
      const effort = display(input.effort).trim();
      if (effort) args.push("--effort", effort);
    }
    args.push("--prompt-interactive");
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
