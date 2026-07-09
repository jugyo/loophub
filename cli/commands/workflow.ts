import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentModel } from "../../core/config.ts";
import { removeDevLock } from "../../core/dev-lock.ts";
import { isClaudeSessionId, RUNTIME_CLAUDE_CODE } from "../../core/resume.ts";
import { flags, rest, sub } from "../args.ts";
import {
  display,
  fail,
  out,
  readStdin,
  resolveRepo,
  run as runOp,
  svc,
  writeSession,
} from "../context.ts";
import { formatSpawnCommand, parseDevTarget, shQuote } from "../dev.ts";
import { usage } from "../usage.ts";

type PromptField =
  | "plan_prompt"
  | "execute_prompt"
  | "verify_prompt"
  | "reflect_prompt";
type PromptStep = "plan" | "execute" | "verify" | "reflect";

const STEP_TO_FIELD: Record<PromptStep, PromptField> = {
  plan: "plan_prompt",
  execute: "execute_prompt",
  verify: "verify_prompt",
  reflect: "reflect_prompt",
};

function nameArg(): string {
  const name = rest[0] || flags.name;
  if (!name) fail("workflow name is required");
  return name;
}

async function fileText(path: string): Promise<string> {
  if (path === "-") return readStdin();
  return readFileSync(path, "utf8");
}

async function promptPatchFromFlags(): Promise<
  Partial<Record<PromptField, string>>
> {
  const patch: Partial<Record<PromptField, string>> = {};
  if (flags["plan-prompt"] !== undefined)
    patch.plan_prompt = flags["plan-prompt"];
  if (flags["execute-prompt"] !== undefined)
    patch.execute_prompt = flags["execute-prompt"];
  if (flags["verify-prompt"] !== undefined)
    patch.verify_prompt = flags["verify-prompt"];
  if (flags["reflect-prompt"] !== undefined)
    patch.reflect_prompt = flags["reflect-prompt"];
  if (flags.step !== undefined || flags.file?.[0] !== undefined) {
    if (!flags.step || !flags.file?.[0])
      fail("--step and --file must be provided together");
    if (
      flags.step !== "plan" &&
      flags.step !== "execute" &&
      flags.step !== "verify" &&
      flags.step !== "reflect"
    )
      fail("--step must be one of: plan, execute, verify, reflect");
    patch[STEP_TO_FIELD[flags.step]] = await fileText(flags.file[0]);
  }
  return patch;
}

function printWorkflow(w: {
  id: number;
  name: string;
  description: string;
  plan_prompt: string;
  execute_prompt: string;
  verify_prompt: string;
  reflect_prompt: string;
}) {
  console.log(`#${w.id}\t${w.name}`);
  if (w.description) console.log(`description\t${w.description}`);
  console.log(`plan_prompt\t${w.plan_prompt}`);
  console.log(`execute_prompt\t${w.execute_prompt}`);
  console.log(`verify_prompt\t${w.verify_prompt}`);
  console.log(`reflect_prompt\t${w.reflect_prompt}`);
}

function workflowIdFlag(): number | undefined {
  if (flags["workflow-id"] === undefined) return undefined;
  if (!/^[0-9]+$/.test(flags["workflow-id"])) {
    fail("--workflow-id must be a positive integer");
  }
  return Number(flags["workflow-id"]);
}

function parentContract(): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "core",
      "pevr",
      "contracts",
      "parent.md",
    ),
    "utf8",
  );
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return !result.error && (result.status ?? 0) === 0;
}

function assertWorkflowStartRuntime(): void {
  if (flags.codex === true || flags.runtime === "codex") {
    fail("PEVR workflow start v1 supports only the claude runtime");
  }
  if (
    flags.runtime &&
    flags.runtime !== RUNTIME_CLAUDE_CODE &&
    flags.runtime !== "claude-code"
  ) {
    fail("PEVR workflow start v1 supports only the claude runtime");
  }
}

function preflightParentLaunch(): void {
  if (flags.herdr === true && !commandAvailable("herdr")) {
    fail("PEVR workflow start v1 requires herdr on PATH");
  }
  if (!commandAvailable("claude")) {
    fail("PEVR workflow start v1 requires claude on PATH");
  }
}

function requestedSessionId(): string | undefined {
  const sessionId = flags["session-id"] || flags.sessionId || undefined;
  if (sessionId !== undefined && !isClaudeSessionId(sessionId)) {
    fail(
      `invalid --session-id for claude runtime: ${JSON.stringify(sessionId)}`,
    );
  }
  return sessionId;
}

function parentClaudeArgs(input: {
  sessionId: string;
  systemPromptPath: string;
  userPrompt: string;
  model: string;
}): string[] {
  return [
    "--session-id",
    input.sessionId,
    "--model",
    input.model,
    ...(flags.auto === true ? ["--permission-mode", "auto"] : []),
    "--append-system-prompt-file",
    input.systemPromptPath,
    input.userPrompt,
  ];
}

function modelFlag(): string {
  if (flags.model !== undefined && typeof flags.model !== "string") {
    fail("--model requires a value");
  }
  const model = typeof flags.model === "string" ? flags.model.trim() : "";
  return model || agentModel("claude-code");
}

function launchParentHerdr(input: {
  worktree: string;
  sessionId: string;
  systemPromptPath: string;
  userPrompt: string;
  model: string;
}): void {
  const claudeArgs = parentClaudeArgs(input);
  const command = formatSpawnCommand(claudeArgs, { bin: "claude" });
  const agentName = `pevr-${input.sessionId.slice(0, 8)}`;
  const launched = spawnSync(
    "herdr",
    [
      "agent",
      "start",
      agentName,
      "--cwd",
      input.worktree,
      "--",
      "zsh",
      "-lc",
      command,
    ],
    { encoding: "utf8", stdio: "inherit" },
  );
  if (launched.error) fail(`failed to launch herdr: ${launched.error.message}`);
  if ((launched.status ?? 0) !== 0) {
    fail(
      `herdr exited with status ${launched.status}\n  reproduce: cd ${shQuote(input.worktree)} && ${command}`,
    );
  }
  const attached = spawnSync("herdr", ["agent", "attach", agentName], {
    stdio: "inherit",
  });
  if (attached.error) fail(`failed to attach herdr: ${attached.error.message}`);
  process.exit(attached.status ?? 0);
}

function launchParentForeground(input: {
  worktree: string;
  sessionId: string;
  systemPromptPath: string;
  userPrompt: string;
  model: string;
}): void {
  const claudeArgs = parentClaudeArgs(input);
  const proc = spawnSync("claude", claudeArgs, {
    stdio: "inherit",
    cwd: input.worktree,
  });
  if (proc.error) fail(`failed to launch claude: ${proc.error.message}`);
  process.exit(proc.status ?? 0);
}

async function startWorkflow(): Promise<void> {
  const target = rest[0];
  const usageLine =
    "usage: lh workflow start <owner>/<repo>/<issue>|<issue> --workflow <name>|--workflow-id <id> [--no-launch]";
  if (!target) fail(usageLine);

  let parsed: { repo?: string; id: number };
  try {
    parsed = parseDevTarget(target);
  } catch (e: any) {
    fail(`${e.message}\n${usageLine}`);
  }
  const repo = parsed.repo ?? (await resolveRepo());
  const workflowId = workflowIdFlag();
  assertWorkflowStartRuntime();
  const sessionId = requestedSessionId();
  const model = modelFlag();
  if (flags.json === true && flags["no-launch"] !== true) {
    fail("--json can only be used with --no-launch for workflow start");
  }
  if (flags["no-launch"] !== true) preflightParentLaunch();
  const s = await svc();
  const result = await runOp(() =>
    s.pevrRuns.start(
      repo,
      {
        issue: parsed.id,
        workflow: flags.workflow,
        workflowId,
        parentContract: parentContract(),
        lockPid: process.pid,
      },
      sessionId,
    ),
  );

  if (flags.json) {
    out(result);
  } else {
    console.log(`started PEVR run #${result.run.id}`);
    console.log(`workflow\t${display(result.workflow.name)}`);
    console.log(`issue\t#${result.issue.number}`);
    console.log(`pr\t#${result.pr.number}`);
    console.log(`worktree\t${display(result.worktree)}`);
    console.log(`session\t${display(result.session_id)}`);
  }

  if (flags["no-launch"] === true) return;
  process.on("exit", () => removeDevLock(result.lock_path));
  const launchInput = {
    worktree: result.worktree,
    sessionId: result.session_id,
    systemPromptPath: result.parent.system_prompt_path,
    userPrompt: result.parent.user_prompt,
    model,
  };
  if (flags.herdr === true) launchParentHerdr(launchInput);
  else launchParentForeground(launchInput);
}

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "list") {
    const workflows = await runOp(() => s.pevrWorkflows.list());
    out(workflows);
    if (!flags.json) {
      for (const w of workflows)
        console.log(`#${w.id}\t${w.name}\t${w.description}`);
    }
  } else if (sub === "view") {
    const workflow = await runOp(() => s.pevrWorkflows.get(nameArg()));
    out(workflow);
    if (!flags.json) printWorkflow(workflow);
  } else if (sub === "create") {
    const promptPatch = await promptPatchFromFlags();
    const workflow = await runOp(async () =>
      s.pevrWorkflows.create(
        {
          name: nameArg(),
          description: flags.description,
          ...promptPatch,
        },
        await writeSession(),
      ),
    );
    if (flags.json) out(workflow);
    else console.log(`created workflow "${workflow.name}" (id ${workflow.id})`);
  } else if (sub === "update") {
    const promptPatch = await promptPatchFromFlags();
    const patch = {
      name: flags.name,
      description: flags.description,
      ...promptPatch,
    };
    if (
      patch.name === undefined &&
      patch.description === undefined &&
      patch.plan_prompt === undefined &&
      patch.execute_prompt === undefined &&
      patch.verify_prompt === undefined &&
      patch.reflect_prompt === undefined
    )
      fail("at least one workflow field must be provided");
    const workflow = await runOp(async () =>
      s.pevrWorkflows.update(nameArg(), patch, await writeSession()),
    );
    if (flags.json) out(workflow);
    else console.log(`updated workflow "${workflow.name}"`);
  } else if (sub === "delete") {
    const name = nameArg();
    const result = await runOp(async () =>
      s.pevrWorkflows.delete(name, await writeSession()),
    );
    if (flags.json) out(result);
    else console.log(`deleted workflow "${name}"`);
  } else if (sub === "start") {
    await startWorkflow();
  } else usage();
}
