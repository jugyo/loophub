import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { agentModel, type CodingAgent } from "../../core/config.ts";
import { removeDevLock } from "../../core/dev-lock.ts";
import { isClaudeSessionId } from "../../core/resume.ts";
import { RUNTIMES, type RuntimeBin } from "../../core/runtimes.ts";
import { buildCodexSandboxArgs } from "../../core/terminal/codex-launch.ts";
import { HERDR_ID } from "../../core/terminal/terminal-launch.ts";
import {
  layoutWorkflowTab,
  WorkflowPaneLayoutError,
  type WorkflowPaneLayoutHerdr,
} from "../../core/terminal/workflow-pane-layout.ts";
import {
  type WorkflowContract,
  workflowContractText,
} from "../../core/workflow/contracts.ts";
import { workflowParentHerdrAgentName } from "../../core/workflow/herdr-agents.ts";
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
import {
  formatSpawnCommand,
  parseDevTarget,
  reconcileTargetRepo,
  resolveDevRuntime,
  shQuote,
} from "../dev.ts";
import {
  HerdrLaunchError,
  type HerdrLaunchResult,
  launchAgentInWorktreeHerdr,
} from "../herdr-launch.ts";
import { usage } from "../usage.ts";

type PromptField = "execute_prompt" | "verify_prompt";
type PromptStep = "execute" | "verify";

const STEP_TO_FIELD: Record<PromptStep, PromptField> = {
  execute: "execute_prompt",
  verify: "verify_prompt",
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
  if (flags["execute-prompt"] !== undefined)
    patch.execute_prompt = flags["execute-prompt"];
  if (flags["verify-prompt"] !== undefined)
    patch.verify_prompt = flags["verify-prompt"];
  if (flags.step !== undefined || flags.file?.[0] !== undefined) {
    if (!flags.step || !flags.file?.[0])
      fail("--step and --file must be provided together");
    if (flags.step !== "execute" && flags.step !== "verify")
      fail("--step must be one of: execute, verify");
    patch[STEP_TO_FIELD[flags.step]] = await fileText(flags.file[0]);
  }
  return patch;
}

function printWorkflow(w: {
  id: number;
  name: string;
  description: string;
  execute_prompt: string;
  verify_prompt: string;
}) {
  console.log(`#${w.id}\t${w.name}`);
  if (w.description) console.log(`description\t${w.description}`);
  console.log(`execute_prompt\t${w.execute_prompt}`);
  console.log(`verify_prompt\t${w.verify_prompt}`);
}

function workflowIdFlag(): number | undefined {
  if (flags["workflow-id"] === undefined) return undefined;
  if (!/^[0-9]+$/.test(flags["workflow-id"])) {
    fail("--workflow-id must be a positive integer");
  }
  return Number(flags["workflow-id"]);
}

function parentContract(): string {
  return contractText("parent");
}

function contractText(step: string): string {
  if (!["parent", "execute", "verify"].includes(step)) {
    fail("step must be one of: execute, verify");
  }
  return workflowContractText(step as WorkflowContract);
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return !result.error && (result.status ?? 0) === 0;
}

// The binary a runtime launches: Claude Code spawns `claude`, Codex spawns `codex`, Grok spawns
// `grok` (#516). Keyed off the runtime registry so a new runtime needs no branch here.
function runtimeBin(runtime: CodingAgent): RuntimeBin {
  return RUNTIMES[runtime].bin;
}

function preflightParentLaunch(runtime: CodingAgent): void {
  if (!commandAvailable("herdr")) {
    fail("workflow start requires herdr on PATH");
  }
  const bin = runtimeBin(runtime);
  if (!commandAvailable(bin)) {
    fail(`workflow start requires ${bin} on PATH`);
  }
}

function preflightStepLaunch(runtime: CodingAgent): void {
  if (!commandAvailable("herdr")) {
    fail("workflow launch-step requires herdr on PATH");
  }
  const bin = runtimeBin(runtime);
  if (!commandAvailable(bin)) {
    fail(`workflow launch-step requires ${bin} on PATH`);
  }
}

// The Herdr seam core's layoutWorkflowTab drives: one spawnSync per command, bound to the run's
// session. Throwing on failure lets the layout operation decide what a failed command means; the
// caller turns the resulting WorkflowPaneLayoutError into a visible non-zero exit.
function herdrPaneLayoutRunner(sessionName: string): WorkflowPaneLayoutHerdr {
  return (args, opts) => {
    const captureStdout = opts?.captureStdout === true;
    const result = spawnSync("herdr", ["--session", sessionName, ...args], {
      encoding: "utf8",
      stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
      timeout: 15_000,
    });
    if (result.error) throw result.error;
    if (result.signal) {
      throw new Error(`herdr terminated by signal ${result.signal}`);
    }
    if (result.status == null || result.status !== 0) {
      throw new Error(`herdr exited with status ${result.status}`);
    }
    return captureStdout ? (result.stdout ?? "") : "";
  };
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

// Build the parent agent argv for the resolved runtime (#516). Claude Code takes --session-id and
// --append-system-prompt-file; Codex and Grok have neither, so the rendered contract is folded into
// their positional prompt and correlation happens only through the LOOPHUB_SESSION_ID env prefix.
function parentAgentArgs(input: {
  runtime: CodingAgent;
  sessionId: string;
  systemPromptPath: string;
  userPrompt: string;
  model: string;
}): string[] {
  const auto = flags.auto === true;
  if (input.runtime === "codex") {
    const systemPrompt = readFileSync(input.systemPromptPath, "utf8");
    return [
      ...(auto ? RUNTIMES.codex.autoApproveArgs : buildCodexSandboxArgs()),
      "--model",
      input.model,
      `${systemPrompt}\n\n${input.userPrompt}`,
    ];
  }
  if (input.runtime === "grok") {
    const systemPrompt = readFileSync(input.systemPromptPath, "utf8");
    // Grok has no sandbox concept (mirrors cli/dev.ts buildGrokArgs): auto opts into its registry
    // approval-bypass; non-auto passes nothing extra.
    return [
      ...(auto ? RUNTIMES.grok.autoApproveArgs : []),
      "--model",
      input.model,
      `${systemPrompt}\n\n${input.userPrompt}`,
    ];
  }
  return [
    "--session-id",
    input.sessionId,
    "--model",
    input.model,
    ...(auto ? RUNTIMES["claude-code"].autoApproveArgs : []),
    "--append-system-prompt-file",
    input.systemPromptPath,
    input.userPrompt,
  ];
}

function inheritedHerdrTabId(): string | null {
  if (flags["tab-id"] !== undefined) {
    if (!HERDR_ID.test(flags["tab-id"])) fail("--tab-id is invalid");
    return flags["tab-id"];
  }
  for (const value of [
    process.env.HERDR_TAB_ID,
    process.env.HERDR_TAB,
    process.env.HERDR_PANE_TAB_ID,
  ]) {
    if (value && HERDR_ID.test(value)) return value;
  }
  return null;
}

// The explicit `--model <name>` a caller passed, or undefined when none was given.
function explicitModelFlag(): string | undefined {
  if (flags.model !== undefined && typeof flags.model !== "string") {
    fail("--model requires a value");
  }
  const model = typeof flags.model === "string" ? flags.model.trim() : "";
  return model || undefined;
}

function positiveInt(value: string | undefined, name: string): number {
  if (!value || !/^[0-9]+$/.test(value) || Number(value) <= 0) {
    fail(`${name} must be a positive integer`);
  }
  return Number(value);
}

async function launchParentHerdr(input: {
  repo: { full_name: string; local_path: string };
  runId: number;
  runtime: CodingAgent;
  worktree: string;
  sessionId: string;
  systemPromptPath: string;
  userPrompt: string;
  model: string;
  // Fire-and-forget (`--herdr`): start the parent agent in its herdr pane and return without the
  // interactive attach, so a non-interactive caller — lh-web's terminal.launch spawns
  // `lh workflow start ... --herdr` headless (#1007) — gets a prompt exit instead of blocking on an
  // attach it has no TTY for.
  detach?: boolean;
}): Promise<void> {
  const bin = runtimeBin(input.runtime);
  const agentArgs = parentAgentArgs(input);
  const command = formatSpawnCommand(agentArgs, { bin });
  const commandWithEnv = `LOOPHUB_SESSION_ID=${shQuote(input.sessionId)} ${command}`;
  const agentName = workflowParentHerdrAgentName(input.runId);
  // Open (or reuse) the target PR worktree's own herdr workspace and start the parent there via the
  // shared launchAgentInWorktreeHerdr helper (#873) — without it herdr split whichever pane was
  // focused, so the Workflow parent could land in an unrelated PR's workspace.
  let launched: HerdrLaunchResult;
  try {
    launched = await launchAgentInWorktreeHerdr({
      repo: input.repo,
      worktree: input.worktree,
      command: commandWithEnv,
      label: agentName,
    });
  } catch (e) {
    if (e instanceof HerdrLaunchError) fail(e.message);
    throw e;
  }
  if (input.detach) {
    // The agent now runs in its herdr pane; exit without attaching. process.exit(0) fires the
    // dev-lock release handler registered in startWorkflow.
    console.error(
      `Launched Workflow parent in herdr agent ${launched.agentName}. Attach with: herdr --session ${launched.sessionName} agent attach ${launched.agentName}`,
    );
    process.exit(0);
  }
  const attached = spawnSync(
    "herdr",
    ["--session", launched.sessionName, "agent", "attach", launched.agentName],
    { stdio: "inherit" },
  );
  if (attached.error) fail(`failed to attach herdr: ${attached.error.message}`);
  process.exit(attached.status ?? 0);
}

async function startWorkflow(): Promise<void> {
  const target = rest[0];
  const usageLine =
    "usage: lh workflow start <owner>/<repo>/<issue>|<issue> --workflow <name>|--workflow-id <id> [--claude-code | --codex | --grok] [--model <name>] [--herdr] [--auto] [--no-launch]";
  if (!target) fail(usageLine);

  let parsed: { repo?: string; id: number };
  try {
    parsed = parseDevTarget(target);
  } catch (e: any) {
    fail(`${e.message}\n${usageLine}`);
  }
  let targetRepo: string | undefined;
  try {
    targetRepo = reconcileTargetRepo(parsed.repo, flags.repo);
  } catch (e: any) {
    fail(e.message);
  }
  const repo = targetRepo ?? (await resolveRepo());
  const workflowId = workflowIdFlag();
  if (flags.json === true && flags["no-launch"] !== true) {
    fail("--json can only be used with --no-launch for workflow start");
  }
  const s = await svc();
  // The repo's effective Coding agent config (#1532) supplies the defaults an explicit
  // --claude-code / --codex / --grok / --model flag still overrides: the run's runtime and — when
  // that runtime matches the effective config's — its model. A flag that selects a different runtime
  // than the override falls back to that runtime's application-default model (agentModel).
  const agentCfg = await runOp(() => s.repos.agentConfig(repo));
  const runtime = resolveDevRuntime({
    claudeCode: flags["claude-code"] === true,
    codex: flags.codex === true,
    grok: flags.grok === true,
    defaultRuntime: agentCfg.effective.runtime,
  });
  const sessionId = requestedSessionId();
  const model =
    explicitModelFlag() ??
    (runtime === agentCfg.effective.runtime
      ? agentCfg.effective.model
      : agentModel(runtime));
  if (flags["no-launch"] !== true) preflightParentLaunch(runtime);
  const result = await runOp(() =>
    s.workflowRuns.start(
      repo,
      {
        issue: parsed.id,
        workflow: flags.workflow,
        workflowId,
        parentContract: parentContract(),
        auto: flags.auto === true,
        runtime,
        // Persist the resolved model (explicit override or config default) so steps inherit it
        // without re-reading config (#516/#594).
        model,
        lockPid: process.pid,
      },
      sessionId,
    ),
  );

  if (flags.json) {
    out(result);
  } else {
    console.log(`started Workflow run #${result.run.id}`);
    console.log(`workflow\t${display(result.workflow.name)}`);
    console.log(`issue\t#${result.issue.number}`);
    console.log(`pr\t#${result.pr.number}`);
    console.log(`worktree\t${display(result.worktree)}`);
    console.log(`session\t${display(result.session_id)}`);
  }

  if (flags["no-launch"] === true) return;
  process.on("exit", () => removeDevLock(result.lock_path));
  const repoRecord = await runOp(() => s.repos.get(repo));
  const launchInput = {
    repo: {
      full_name: repoRecord.full_name,
      local_path: repoRecord.local_path,
    },
    runId: result.run.id,
    runtime,
    worktree: result.worktree,
    sessionId: result.session_id,
    systemPromptPath: result.parent.system_prompt_path,
    userPrompt: result.parent.user_prompt,
    model,
    // `--herdr` starts the parent fire-and-forget (no interactive attach) so lh-web can spawn this
    // headless (#1007); without it the CLI attaches for a human at a terminal.
    detach: flags.herdr === true,
  };
  await launchParentHerdr(launchInput);
}

async function launchStep(): Promise<void> {
  const runId = positiveInt(flags.run, "--run");
  const step = flags.step;
  if (!step) fail("--step is required");
  const repo = await resolveRepo();
  const note =
    flags.note === "-"
      ? await readStdin()
      : typeof flags.note === "string"
        ? flags.note
        : undefined;
  // The rework pointer: the review the relaunched Execute child must address (#1358).
  const review =
    flags.review !== undefined
      ? positiveInt(flags.review, "--review")
      : undefined;
  const s = await svc();
  if (flags["no-launch"] === true) {
    fail("--no-launch is not supported for workflow launch-step");
  }
  if (flags.json === true) {
    fail("--json is not supported for workflow launch-step");
  }
  const tabId = inheritedHerdrTabId();
  const actorSessionId = await writeSession();
  const result = await runOp(() =>
    s.workflowRuns.launchStep(
      repo,
      {
        run: runId,
        step,
        note,
        review,
        contract: contractText(step),
        // The step inherits the parent run's model; only forward an explicit --model override.
        model: explicitModelFlag(),
        auto: flags.auto === true,
        tabId,
      },
      actorSessionId,
    ),
  );
  // Preflight the runtime the run resolved (#516) — claude-code needs `claude`, codex needs `codex`.
  preflightStepLaunch(result.runtime);
  if (result.step === "verify") {
    await runOp(() =>
      s.workflowRuns.closePreviousVerifyPane(
        repo,
        { run: result.run.id },
        actorSessionId,
      ),
    );
  }
  console.log(
    `launched Workflow ${result.step} step for run #${result.run.id}`,
  );
  console.log(`agent\t${display(result.agent_name)}`);
  console.log(`session\t${display(result.session_id)}`);
  console.log(`worktree\t${display(result.worktree)}`);
  console.log(`contract\t${display(result.system_prompt_path)}`);
  for (const pointer of result.pointers) {
    console.log(`input\t${display(pointer.label)}\t${display(pointer.value)}`);
  }
  const confirm = () =>
    runOp(() =>
      s.workflowRuns.confirmStepLaunch(
        repo,
        {
          run: result.run.id,
          step: result.step,
          sessionId: result.session_id,
          agentName: result.agent_name,
          pointers: result.pointers,
          headSha: result.head_sha,
          note,
        },
        actorSessionId,
      ),
    );
  const launched = spawnSync(result.herdr.argv[0], result.herdr.argv.slice(1), {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (launched.error) fail(`failed to launch herdr: ${launched.error.message}`);
  if (launched.signal) {
    fail(`herdr terminated by signal ${launched.signal}`);
  }
  if (launched.status == null || launched.status !== 0) {
    fail(`herdr exited with status ${launched.status}`);
  }
  // The child process is live once agent start succeeds, so persist that truth before ancillary
  // layout work. A layout failure remains a visible non-zero exit; it must not leave a running child
  // unrecorded, and launch-step never retries automatically (an explicit retry is a new session).
  await confirm();
  if (tabId) {
    try {
      layoutWorkflowTab({
        tabId,
        runId: result.run.id,
        herdr: herdrPaneLayoutRunner(result.herdr.sessionName),
      });
    } catch (e) {
      if (e instanceof WorkflowPaneLayoutError) fail(e.message);
      throw e;
    }
  } else {
    // Preserve the legacy/headless launch path that had no placement selector. There is no safe
    // target to rebuild in this case, so make the missing visual guarantee explicit without moving
    // whichever unrelated tab happens to be focused.
    console.error(
      "warning: skipped Workflow pane layout because no parent Herdr tab id was available",
    );
  }
}

async function runLifecycle(): Promise<void> {
  const action = rest[0];
  const runId = positiveInt(flags.run, "--run");
  const repo = await resolveRepo();
  const sessionId = await writeSession();
  const service = (await svc()).workflowRuns;
  const result = await runOp(() => {
    if (action === "advance-to-verify") {
      return service.advanceToVerify(repo, { run: runId }, sessionId);
    }
    if (action === "request-rework") {
      return service.requestRework(repo, { run: runId }, sessionId);
    }
    if (action === "await-human") {
      if (!flags.reason) fail("--reason is required");
      return service.awaitHuman(
        repo,
        { run: runId, reason: flags.reason },
        sessionId,
      );
    }
    if (action === "resume") {
      if (!flags.step) fail("--step is required");
      return service.resumeAfterHuman(
        repo,
        { run: runId, step: flags.step },
        sessionId,
      );
    }
    usage();
    throw new Error("unreachable");
  });
  if (flags.json) out(result);
  else {
    console.log(`${action} Workflow run #${result.run.id}`);
    console.log(`status\t${display(result.run.status)}`);
    console.log(`step\t${display(result.run.current_step)}`);
    console.log(`rework_count\t${result.run.rework_count}`);
    if (result.run.needs_human_reason !== null) {
      console.log(`needs_human\t${display(result.run.needs_human_reason)}`);
    }
  }
}

const STEP_STATUS_ORDER = ["execute", "verify"] as const;

async function stepInput(): Promise<void> {
  const runId = positiveInt(rest[1], "<run>");
  const step = rest[2];
  if (!step) {
    fail(
      "usage: lh workflow step input <run> <step> [--note <text|->] [--review <id>]",
    );
  }
  const note =
    flags.note === "-"
      ? await readStdin()
      : typeof flags.note === "string"
        ? flags.note
        : undefined;
  const review =
    flags.review !== undefined
      ? positiveInt(flags.review, "--review")
      : undefined;
  const repo = await resolveRepo();
  const result = await runOp(async () =>
    (await svc()).workflowRuns.stepInput(repo, {
      run: runId,
      step,
      note,
      review,
      contract: contractText(step),
    }),
  );
  if (flags.json) {
    out(result);
    return;
  }
  console.log(`--- system prompt (contract: ${result.step}) ---`);
  console.log(result.system_prompt);
  console.log("--- input pointers ---");
  for (const pointer of result.pointers) {
    console.log(`${display(pointer.label)}\t${display(pointer.value)}`);
  }
  console.log("--- user prompt ---");
  console.log(result.user_prompt);
}

async function stepStatus(): Promise<void> {
  const runId = positiveInt(rest[1], "<run>");
  const repo = await resolveRepo();
  const result = await runOp(async () =>
    (await svc()).workflowRuns.status(repo, { run: runId }),
  );
  if (flags.json) {
    out(result);
    return;
  }
  if (result.needs_human_reason !== null) {
    console.log(`needs_human\t${display(result.needs_human_reason)}`);
  }
  console.log(`head\t${display(result.head_sha ?? "(unresolved)")}`);
  if (result.last_turn_done_at !== null) {
    console.log(`last_turn_done\t${display(result.last_turn_done_at)}`);
  }
  for (const step of STEP_STATUS_ORDER) {
    const s = result.steps[step];
    const label = s.complete
      ? "complete"
      : `incomplete — ${s.missing.join("; ")}`;
    console.log(`${step}\t${label}`);
    if (step === "verify" && result.steps.verify.latest_review) {
      const review = result.steps.verify.latest_review;
      console.log(
        `\tlatest review: #${review.id} ${review.event} (${review.fresh ? "fresh" : "stale"})`,
      );
    }
  }
}

// The Execute child's payload-less turn-done declaration (#1358). Target resolution mirrors the
// launched-session environment (LOOPHUB_WORKFLOW_*), so the child needs no flags.
async function turnDone(): Promise<void> {
  if (rest[0] !== "done") usage();
  const runId = positiveInt(
    flags.run ?? process.env.LOOPHUB_WORKFLOW_RUN,
    "--run or LOOPHUB_WORKFLOW_RUN",
  );
  const repo =
    flags.repo ?? process.env.LOOPHUB_WORKFLOW_REPO ?? (await resolveRepo());
  const result = await runOp(async () =>
    (await svc()).workflowRuns.turnDone(
      repo,
      { run: runId },
      await writeSession(),
    ),
  );
  if (flags.json) out(result);
  else
    console.log(
      `declared turn done for Workflow run #${result.run} (event #${result.event_id})`,
    );
}

async function escalate(): Promise<void> {
  if (!flags.reason) fail("--reason is required");
  const reason = flags.reason;
  const runId = positiveInt(
    flags.run ?? process.env.LOOPHUB_WORKFLOW_RUN,
    "--run or LOOPHUB_WORKFLOW_RUN",
  );
  const repo =
    flags.repo ?? process.env.LOOPHUB_WORKFLOW_REPO ?? (await resolveRepo());
  const result = await runOp(async () =>
    (await svc()).workflowRuns.escalate(
      repo,
      { run: runId, reason },
      await writeSession(),
    ),
  );
  if (flags.json) out(result);
  else
    console.log(
      `declared escalation for Workflow run #${result.run} (event #${result.event_id})`,
    );
}

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "list") {
    const workflows = await runOp(() => s.workflows.list());
    out(workflows);
    if (!flags.json) {
      for (const w of workflows)
        console.log(`#${w.id}\t${w.name}\t${w.description}`);
    }
  } else if (sub === "view") {
    const workflow = await runOp(() => s.workflows.get(nameArg()));
    out(workflow);
    if (!flags.json) printWorkflow(workflow);
  } else if (sub === "create") {
    const promptPatch = await promptPatchFromFlags();
    const workflow = await runOp(async () =>
      s.workflows.create(
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
      patch.execute_prompt === undefined &&
      patch.verify_prompt === undefined
    )
      fail("at least one workflow field must be provided");
    const workflow = await runOp(async () =>
      s.workflows.update(nameArg(), patch, await writeSession()),
    );
    if (flags.json) out(workflow);
    else console.log(`updated workflow "${workflow.name}"`);
  } else if (sub === "delete") {
    const name = nameArg();
    const result = await runOp(async () =>
      s.workflows.delete(name, await writeSession()),
    );
    if (flags.json) out(result);
    else console.log(`deleted workflow "${name}"`);
  } else if (sub === "start") {
    await startWorkflow();
  } else if (sub === "launch-step") {
    await launchStep();
  } else if (sub === "run") {
    await runLifecycle();
  } else if (sub === "turn") {
    await turnDone();
  } else if (sub === "escalate") {
    await escalate();
  } else if (sub === "step") {
    if (rest[0] === "input") await stepInput();
    else if (rest[0] === "status") await stepStatus();
    else usage();
  } else usage();
}
