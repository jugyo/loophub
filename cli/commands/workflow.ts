import { spawnSync } from "node:child_process";
import { agentModel, type CodingAgent } from "../../core/config.ts";
import { removeDevLock } from "../../core/dev-lock.ts";
import { buildRuntimeFlags } from "../../core/runtime-args.ts";
import { RUNTIMES, type RuntimeBin } from "../../core/runtimes.ts";
import { isClaudeSessionId } from "../../core/session-runtime.ts";
import {
  agentCommandLine,
  executeHerdrLaunchPlan,
  HERDR_ID,
  herdrAgentFocusArgv,
  herdrTabFocusArgv,
} from "../../core/terminal/terminal-launch.ts";
import {
  layoutWorkflowTab,
  type WorkflowPaneLayoutHerdr,
} from "../../core/terminal/workflow-pane-layout.ts";
import { workflowParentHerdrAgentName } from "../../core/workflow/herdr-agents.ts";
import { flags, rest, sub } from "../args.ts";
import {
  display,
  fail,
  out,
  resolveRepo,
  run as runOp,
  svc,
  writeSession,
} from "../context.ts";
import {
  parseDevTarget,
  reconcileTargetRepo,
  resolveDevRuntime,
} from "../dev.ts";
import {
  HerdrLaunchError,
  type HerdrLaunchResult,
  launchAgentInWorktreeHerdr,
} from "../herdr-launch.ts";
import { readTextInput } from "../text-input.ts";
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
  return readTextInput(path, { bareFile: true });
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

function manifestRunId(): number {
  return positiveInt(rest[1], "run");
}

async function manifestCommand(): Promise<void> {
  const action = rest[0];
  if (action !== "show" && action !== "path") usage();
  const runId = manifestRunId();
  const repo = await resolveRepo();
  const service = (await svc()).workflowRuns;
  if (action === "path") {
    console.log(await runOp(() => service.manifestPath(repo, runId)));
    return;
  }
  const result = await runOp(() => service.manifestView(repo, runId));
  if (flags.json) {
    out(result);
    return;
  }
  console.log(`動作条件 (manifest)\t${result.manifest_path}`);
  console.log(`contract_language\t${result.manifest.contract_language}`);
  for (const kind of ["parent", "execute", "verify"] as const) {
    const agent = result.manifest.agents[kind];
    console.log(`${kind}.runtime\t${agent.runtime}`);
    console.log(`${kind}.model\t${agent.model}`);
    console.log(`${kind}.effort\t${agent.effort}`);
  }
  console.log("pointer (DB)");
  for (const pointer of result.pointers) {
    console.log(`${pointer.label}\t${pointer.value}`);
  }
  console.log("workspace (規約から導出)");
  console.log(`worktree_path\t${result.workspace.worktree_path}`);
  console.log(`branch\t${result.workspace.branch}`);
  console.log(`base_branch\t${result.workspace.base_branch}`);
  console.log("反映タイミング");
  console.log(`next_child\t${result.change_timing.next_child}`);
  console.log(`parent\t${result.change_timing.parent}`);
  console.log(`execute\t${result.change_timing.execute}`);
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

function stepLaunchPreflightError(runtime: CodingAgent): string | null {
  if (!commandAvailable("herdr")) {
    return "workflow launch-step requires herdr on PATH";
  }
  const bin = runtimeBin(runtime);
  if (!commandAvailable(bin)) {
    return `workflow launch-step requires ${bin} on PATH`;
  }
  return null;
}

// The Herdr seam core's layoutWorkflowTab drives: one spawnSync per command, bound to the run's
// session. Layout is best-effort and does not change launch-step's result after confirmation.
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

// Build the parent agent's flag argv for the resolved runtime (#516) via the registry-driven core
// helper. Claude Code takes --session-id and --append-system-prompt-file; Codex and Grok have
// neither, so the rendered contract is folded into their positional prompt (already done when the
// run wrote its prompt file) and correlation happens only through the LOOPHUB_SESSION_ID env prefix.
function parentAgentFlags(input: {
  runtime: CodingAgent;
  sessionId: string;
  systemPromptPath: string;
  model: string;
  effort: string;
}): string[] {
  return buildRuntimeFlags({
    runtime: input.runtime,
    model: input.model,
    effort: input.effort,
    sessionId: input.sessionId,
    systemPromptFile: input.systemPromptPath,
  });
}

// This process's own herdr pane. Placement no longer depends on it: launch-step anchors a child to
// the pane the run's parent launch registered, and derives the tab from that pane. This is only the
// fallback for a run that has no registered pane at all, and the `--pane-id` escape hatch for
// naming one explicitly.
function inheritedHerdrPaneId(): string | null {
  if (flags["pane-id"] !== undefined) {
    if (!HERDR_ID.test(flags["pane-id"])) fail("--pane-id is invalid");
    return flags["pane-id"];
  }
  const value = process.env.HERDR_PANE_ID;
  return value && HERDR_ID.test(value) ? value : null;
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

function positiveNumber(value: string | undefined, name: string): number {
  if (value === undefined) fail(`${name} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${name} must be a positive number`);
  }
  return parsed;
}

async function launchParentHerdr(input: {
  repo: { full_name: string; local_path: string };
  runId: number;
  runtime: CodingAgent;
  worktree: string;
  sessionId: string;
  systemPromptPath: string;
  userPromptPath: string;
  model: string;
  effort: string;
  // Fire-and-forget (`--herdr`): start the parent agent in its herdr pane and return without the
  // interactive attach, so a non-interactive caller — lh-web's terminal.launch spawns
  // `lh workflow start ... --herdr` headless (#1007) — gets a prompt exit instead of blocking on an
  // attach it has no TTY for.
  detach?: boolean;
}): Promise<void> {
  const env = { LOOPHUB_SESSION_ID: input.sessionId };
  const command = agentCommandLine({
    env,
    bin: runtimeBin(input.runtime),
    args: parentAgentFlags(input),
    promptPath: input.userPromptPath,
  });
  const label = workflowParentHerdrAgentName(input.runId);
  // Open (or reuse) the target PR worktree's own herdr workspace and start the parent there via the
  // shared launchAgentInWorktreeHerdr helper (#873) — without it herdr split whichever pane was
  // focused, so the Workflow parent could land in an unrelated PR's workspace.
  let launched: HerdrLaunchResult;
  const launchedAt = new Date().toISOString();
  try {
    launched = await launchAgentInWorktreeHerdr({
      repo: input.repo,
      worktree: input.worktree,
      env,
      command,
      label,
    });
  } catch (e) {
    if (e instanceof HerdrLaunchError) fail(e.message);
    throw e;
  }
  const s = await svc();
  await runOp(() =>
    s.workflowInstructions.registerParentPane(input.repo.full_name, {
      run: input.runId,
      launch_id: input.sessionId,
      session_name: launched.sessionName,
      pane_id: launched.paneId,
      launched_at: launchedAt,
    }),
  );
  // Create/open stayed `--no-focus` so a half-built launch never steals the operator's view.
  // Once the Workflow parent is running, bring its tab (or pane) forward so Start workflow —
  // Web UI and `lh workflow start --herdr` alike — lands on the new run. Best-effort: a failed
  // focus must not fail a successful launch (or block attach below).
  if (launched.tabId) {
    spawnSync("herdr", herdrTabFocusArgv(input.repo, launched.tabId).slice(1), {
      stdio: "ignore",
    });
  } else if (launched.paneId) {
    spawnSync(
      "herdr",
      herdrAgentFocusArgv(input.repo, launched.paneId).slice(1),
      { stdio: "ignore" },
    );
  }
  // The session, not the agent: `herdr agent attach` resolves its target through herdr's agent
  // detection, and the runtime the pane was just told to run has not been detected yet.
  const attachHint = `herdr session attach ${launched.sessionName}`;
  if (input.detach) {
    // The agent now runs in its herdr pane; exit without attaching. process.exit(0) fires the
    // dev-lock release handler registered in startWorkflow.
    console.error(
      `Launched Workflow parent in herdr pane ${launched.paneId}. Attach with: ${attachHint}`,
    );
    process.exit(0);
  }
  const attached = spawnSync(
    "herdr",
    ["session", "attach", launched.sessionName],
    {
      stdio: "inherit",
    },
  );
  if (attached.error) fail(`failed to attach herdr: ${attached.error.message}`);
  process.exit(attached.status ?? 0);
}

async function startWorkflow(): Promise<void> {
  const target = rest[0];
  const usageLine =
    "usage: lh workflow start <owner>/<repo>/<issue>|<issue> --workflow <name>|--workflow-id <id> [--claude-code | --codex | --grok | --opencode] [--model <name>] [--herdr] [--no-launch]";
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
  // An explicit runtime/model flag still overrides: the run's runtime and — when
  // that runtime matches the effective config's — its model. A flag that selects a different runtime
  // than the override falls back to that runtime's application-default model (agentModel).
  const agentCfg = await runOp(() => s.repos.agentConfig(repo));
  const runtime = resolveDevRuntime({
    claudeCode: flags["claude-code"] === true,
    codex: flags.codex === true,
    grok: flags.grok === true,
    opencode: flags.opencode === true,
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
    userPromptPath: result.parent.user_prompt_path,
    model,
    effort: result.parent.effort,
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
    typeof flags.note === "string"
      ? await readTextInput(flags.note)
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
  const paneId = inheritedHerdrPaneId();
  const actorSessionId = await writeSession();
  const result = await runOp(() =>
    s.workflowRuns.launchStep(
      repo,
      {
        run: runId,
        step,
        note,
        review,
        deliveryId: flags["delivery-id"],
        // The step inherits the parent run's model; only forward an explicit --model override.
        model: explicitModelFlag(),
        paneId,
      },
      actorSessionId,
    ),
  );
  const failUnspawnedLaunch = async (message: string): Promise<never> => {
    await runOp(() =>
      s.workflowRuns.failStepLaunch(
        repo,
        {
          run: result.run.id,
          sessionId: result.session_id,
          reason: message,
        },
        actorSessionId,
      ),
    );
    fail(message);
  };
  const failUnspawnedLaunchWith = async (error: unknown): Promise<never> => {
    await runOp(() =>
      s.workflowRuns.failStepLaunch(
        repo,
        {
          run: result.run.id,
          sessionId: result.session_id,
          reason: error instanceof Error ? error.message : String(error),
        },
        actorSessionId,
      ),
    );
    return runOp(() => {
      throw error;
    });
  };
  // Preflight the runtime the run resolved (#516) — claude-code needs `claude`, codex needs `codex`.
  const preflightError = stepLaunchPreflightError(result.runtime);
  if (preflightError) await failUnspawnedLaunch(preflightError);
  if (result.step === "verify") {
    // This launch is the moment an older Verify child is known to be reviewing a HEAD the run has
    // moved past — stop it here rather than pay for a review the freshness check will ignore (#61).
    let stale: Awaited<
      ReturnType<typeof s.workflowRuns.discardStaleVerifyChildren>
    >;
    try {
      stale = await s.workflowRuns.discardStaleVerifyChildren(
        repo,
        { run: result.run.id },
        actorSessionId,
      );
    } catch (error) {
      return await failUnspawnedLaunchWith(error);
    }
    for (const discarded of stale.discarded) {
      console.log(
        `discarded\t${display(discarded.agent_name ?? discarded.session_id)}`,
      );
    }
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
  let launchedAt: string | undefined;
  const confirm = (paneId: string) =>
    runOp(() =>
      s.workflowRuns.confirmStepLaunch(
        repo,
        {
          run: result.run.id,
          step: result.step,
          sessionId: result.session_id,
          runtime: result.runtime,
          agentName: result.agent_name,
          executionTarget: {
            provider: "herdr",
            targetId: paneId,
            context: result.herdr.sessionName,
          },
          pointers: result.pointers,
          headSha: result.head_sha,
          note,
          model: result.model,
          effort: result.effort,
          launchedAt,
        },
        actorSessionId,
      ),
    );
  launchedAt = new Date().toISOString();
  const outcome = await executeHerdrLaunchPlan(result.herdr, async (argv) => {
    const proc = spawnSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 30_000,
    });
    return {
      stdout: proc.stdout ?? "",
      stderr: proc.error ? proc.error.message : (proc.stderr ?? ""),
      ok: !proc.error && proc.signal == null && (proc.status ?? 0) === 0,
    };
  });
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (!outcome.ok) {
    await failUnspawnedLaunch(
      `herdr failed to ${
        outcome.failed === "pane"
          ? "create the step's pane"
          : "start the step agent"
      }: ${outcome.stderr.trim()}`,
    );
  }
  const childPaneId = outcome.paneId;
  if (!childPaneId) {
    return await failUnspawnedLaunch(
      "herdr returned no valid pane_id for the step's pane",
    );
  }
  // The child's command is in its pane once the launch succeeds, so persist that truth before
  // ancillary layout work. Layout is best-effort and must not turn a recorded launch into a
  // failure; launch-step never retries automatically (an explicit retry is a new session).
  await confirm(childPaneId);
  if (result.anchor_pane_id) {
    layoutWorkflowTab({
      anchorPaneId: result.anchor_pane_id,
      runId: result.run.id,
      herdr: herdrPaneLayoutRunner(result.herdr.sessionName),
    });
  } else {
    // Preserve the legacy/headless launch path that had no placement anchor. The child got its own
    // tab, so there is no run tab to rebuild; make the missing visual guarantee explicit without
    // moving whichever unrelated tab happens to be focused.
    console.error(
      "warning: skipped Workflow pane layout because the run has no anchor Herdr pane",
    );
  }
}

async function runLifecycle(): Promise<void> {
  const action = rest[0];
  const runId = positiveInt(flags.run, "--run");
  const repo = await resolveRepo();
  const sessionId = await writeSession();
  const service = (await svc()).workflowRuns;
  if (action === "increase-cost-limit") {
    const expectedLimitUsd = positiveNumber(
      flags["expected-limit"],
      "--expected-limit",
    );
    const result = await runOp(() =>
      service.increaseCostLimit(
        repo,
        { run: runId, expectedLimitUsd },
        sessionId,
      ),
    );
    if (flags.json) out(result);
    else {
      console.log(`increased cost limit for Workflow run #${result.run}`);
      console.log(`previous_limit_usd\t${result.previous_limit_usd}`);
      console.log(`current_limit_usd\t${result.current_limit_usd}`);
    }
    return;
  }
  const result = await runOp(async () => {
    if (action === "advance-to-verify") {
      return service.advanceToVerify(repo, { run: runId }, sessionId);
    }
    if (action === "request-rework") {
      return service.requestRework(repo, { run: runId }, sessionId);
    }
    if (action === "activate-step") {
      if (!flags.step) fail("--step is required");
      if (!flags.session) fail("--session is required");
      return service.activateStep(
        repo,
        { run: runId, step: flags.step, sessionId: flags.session },
        sessionId,
      );
    }
    if (action === "await-human") {
      if (!flags.reason) fail("--reason is required");
      const reason = await readTextInput(flags.reason);
      return service.awaitHuman(repo, { run: runId, reason }, sessionId);
    }
    if (action === "resume") {
      if (!flags.step) fail("--step is required");
      return service.resumeAfterHuman(
        repo,
        { run: runId, step: flags.step },
        sessionId,
      );
    }
    if (action === "recover-launch") {
      if (!flags.reason) fail("--reason is required");
      const reason = await readTextInput(flags.reason);
      return service.recoverStepLaunch(repo, { run: runId, reason }, sessionId);
    }
    usage();
    throw new Error("unreachable");
  });
  if (flags.json) out(result);
  else {
    console.log(`${action} Workflow run #${result.run.id}`);
    console.log(`status\t${display(result.run.status)}`);
    console.log(`step\t${display(result.run.current_step)}`);
    if (result.run.active_step !== null) {
      console.log(`active_step\t${display(result.run.active_step)}`);
      console.log(
        `active_session\t${display(result.run.active_session_id ?? "(unresolved)")}`,
      );
    }
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
    typeof flags.note === "string"
      ? await readTextInput(flags.note)
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
  if (result.pending_step_launch !== null) {
    const launch = result.pending_step_launch;
    console.log(
      `pending_launch\t${display(launch.step)} ${display(launch.session_id)} ${display(launch.head_sha ?? "(no head)")}`,
    );
  }
  console.log(`rework\t${result.rework_count}/${result.rework_limit}`);
  if (result.pending_effect_receipt !== null) {
    const receipt = result.pending_effect_receipt;
    console.log(
      `pending_effect\t#${receipt.event_id} ${display(receipt.effect)}`,
    );
  }
  for (const review of result.unaddressed_out_of_band_reviews) {
    console.log(`unaddressed_review\t#${review.id} ${display(review.verdict)}`);
  }
  console.log(`cost_increment_usd\t${result.cost_increment_usd}`);
  console.log(`cost_limit_usd\t${result.cost_limit_usd}`);
  console.log(`head\t${display(result.head_sha ?? "(unresolved)")}`);
  console.log(`display_stage\t${result.display_stage}`);
  console.log(`merge_ready\t${result.merge_ready}`);
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

// The parent's own inputs to the run: a direct human instruction, or its verdict on the GitHub
// references a delivered instruction asked it to read. State-derived instructions reach the parent
// through the worker, so this command always carries one input rather than polling for progress.
async function instruction(): Promise<void> {
  const runId = positiveInt(rest[0], "<run>");
  const event =
    flags.event === undefined ? undefined : positiveInt(flags.event, "--event");
  const note =
    typeof flags.note === "string"
      ? await readTextInput(flags.note)
      : undefined;
  if (event !== undefined && note !== undefined) {
    fail("workflow instruction accepts either --event or --note");
  }
  if (event === undefined && note === undefined) {
    fail("workflow instruction requires --event or --note");
  }
  const requiresChanges =
    flags["requires-changes"] === undefined
      ? undefined
      : flags["requires-changes"] === "true"
        ? true
        : flags["requires-changes"] === "false"
          ? false
          : fail("--requires-changes must be true or false");
  if (event !== undefined && requiresChanges === undefined) {
    fail("--event requires --requires-changes");
  }
  const repo = await resolveRepo();
  const result = await runOp(async () =>
    (await svc()).workflowRuns.next(repo, {
      run: runId,
      event,
      note,
      requiresChanges,
    }),
  );
  if (flags.json) {
    out(result);
    return;
  }
  console.log(result.action);
  console.log(result.reason);
  if (result.action === "read_github_reference") {
    for (const reference of result.references)
      console.log(`reference\t${reference}`);
  }
  if (result.event)
    console.log(`event\t#${result.event.id} ${result.event.type}`);
}

// The Execute child's payload-less turn-done declaration (#1358). The rendered contract supplies
// the run explicitly; repo resolution can still use the child's worktree cwd.
async function turnDone(): Promise<void> {
  if (rest[0] !== "done") usage();
  const runId = positiveInt(flags.run, "--run");
  const repo = flags.repo ?? (await resolveRepo());
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

// The parent's first act after launch: declare that its agent is up and reads its pane. Instructions
// are held until this arrives, because bytes written to the pane before the agent attaches to it are
// lost and the delivery still records itself as done (#2156).
async function parentReady(): Promise<void> {
  const runId = positiveInt(rest[0], "<run>");
  const repo = await resolveRepo();
  const result = await runOp(async () =>
    (await svc()).workflowInstructions.parentReady(repo, { run: runId }),
  );
  if (flags.json) out(result);
  else {
    console.log(
      `parent is ready for Workflow run #${result.run} (${result.ready_at})`,
    );
    if (result.instruction.status === "delivered") {
      console.log(
        `delivered Workflow instruction for event #${result.instruction.event}`,
      );
    }
  }
}

async function escalate(): Promise<void> {
  if (!flags.reason) fail("--reason is required");
  const reason = await readTextInput(flags.reason);
  const runId = positiveInt(flags.run, "--run");
  const repo = flags.repo ?? (await resolveRepo());
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

async function deliver(): Promise<void> {
  const runId = positiveInt(flags.run, "--run");
  if (flags.text === undefined) fail("--text is required");
  const text = await readTextInput(flags.text);
  const repo = await resolveRepo();
  const result = await runOp(async () =>
    (await svc()).workflowRuns.deliver(
      repo,
      {
        run: runId,
        text,
        target: flags.target,
        deliveryId: flags["delivery-id"],
      },
      await writeSession(),
    ),
  );
  if (flags.json) out(result);
  else if ("queued" in result) {
    console.log(`queued instruction for ${result.target}`);
    console.log(`delivery\t${result.delivery_id}`);
  } else {
    console.log(`delivered instruction to ${result.agent_name}`);
    console.log(`pane\t${result.pane_id}`);
    console.log(`session\t${result.session_id}`);
  }
}

async function escalateHuman(): Promise<void> {
  if (!flags.reason) fail("--reason is required");
  const reason = await readTextInput(flags.reason);
  const runId = positiveInt(flags.run, "--run");
  const repo = flags.repo ?? (await resolveRepo());
  const result = await runOp(async () =>
    (await svc()).workflowEscalation.escalateHuman(
      repo,
      { run: runId, reason },
      await writeSession(),
    ),
  );
  if (flags.json) {
    out(result);
  } else {
    console.log(`Workflow run #${result.run}\tPR #${result.pr}`);
    const effect = result.effects.pr_comment;
    console.log(`pr comment\t${effect.status.replaceAll("_", " ")}`);
    if (effect.error) console.log(`pr comment error\t${effect.error}`);
  }
  if (!result.ok) {
    fail("escalate-human did not record the PR comment");
  }
}

async function effect(): Promise<void> {
  const action = rest[0];
  if (action !== "begin" && action !== "complete") usage();
  const run = positiveInt(flags.run, "--run");
  const event = positiveInt(flags.event, "--event");
  if (!flags.effect) fail("--effect is required");
  const repo = await resolveRepo();
  const service = (await svc()).workflowEffects;
  const input = { repo, run, event, effect: flags.effect };
  const result = await runOp(() =>
    action === "begin"
      ? service.beginEffect(input)
      : service.completeEffect(input),
  );
  if (flags.json) out(result);
  else if (action === "begin") {
    console.log(
      result.execute
        ? `claimed effect ${result.effect} for event #${result.event}`
        : `${result.status} effect ${result.effect} for event #${result.event}`,
    );
  } else {
    console.log(`completed effect ${result.effect} for event #${result.event}`);
  }
}

async function costHold(): Promise<void> {
  const run = positiveInt(flags.run, "--run");
  const event = positiveInt(flags.event, "--event");
  const repo = await resolveRepo();
  const result = await runOp(async () =>
    (await svc()).workflowCostHold.run(
      repo,
      { run, event },
      await writeSession(),
    ),
  );
  if (flags.json) out(result);
  if (result.status === "completed") {
    if (!flags.json) {
      console.log(`completed cost hold for event #${event}`);
      console.log(`receipt\t${result.receipt}`);
    }
    return;
  }
  if (result.status === "already_completed") {
    if (!flags.json) {
      console.log(`cost hold for event #${event} is already complete`);
      console.log(`receipt\t${result.receipt}`);
    }
    return;
  }
  if (result.status === "pending") {
    fail(
      `cost hold for event #${event} is pending; side effects will not be replayed automatically`,
    );
  }
  const failure = result.failed!;
  fail(
    [
      `cost hold failed at ${failure.step}`,
      `command: ${failure.command}`,
      `error: ${failure.error}`,
      `completed: ${result.completed.join(", ") || "none"}`,
      `receipt: ${result.receipt}`,
    ].join("\n"),
  );
}

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "list") {
    const workflows = await runOp(() =>
      s.workflows.list(
        flags.repo ? { scope: { repo: flags.repo } } : { scope: "global" },
      ),
    );
    out(workflows);
    if (!flags.json) {
      for (const w of workflows)
        console.log(`#${w.id}\t${w.name}\t${w.description}`);
    }
  } else if (sub === "view") {
    const workflow = await runOp(() => s.workflows.get(nameArg(), flags.repo));
    out(workflow);
    if (!flags.json) printWorkflow(workflow);
  } else if (sub === "create") {
    const promptPatch = await promptPatchFromFlags();
    const workflow = await runOp(async () =>
      s.workflows.create(
        {
          name: nameArg(),
          description: flags.description,
          repo: flags.repo,
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
      workflowIdFlag() !== undefined
        ? s.workflows.updateById(workflowIdFlag()!, patch, await writeSession())
        : s.workflows.update(
            nameArg(),
            patch,
            await writeSession(),
            flags.repo,
          ),
    );
    if (flags.json) out(workflow);
    else console.log(`updated workflow "${workflow.name}"`);
  } else if (sub === "delete") {
    const id = workflowIdFlag();
    const name = id === undefined ? nameArg() : undefined;
    const result = await runOp(async () =>
      id !== undefined
        ? s.workflows.deleteById(id, await writeSession())
        : s.workflows.delete(name!, await writeSession(), flags.repo),
    );
    if (flags.json) out(result);
    else console.log(`deleted workflow ${name ? `"${name}"` : `#${id}`}`);
  } else if (sub === "archive") {
    const id = workflowIdFlag();
    const workflow = await runOp(async () =>
      id !== undefined
        ? s.workflows.archiveById(id, await writeSession())
        : s.workflows.archive(nameArg(), await writeSession(), flags.repo),
    );
    if (flags.json) out(workflow);
    else console.log(`archived workflow "${workflow.name}"`);
  } else if (sub === "start") {
    await startWorkflow();
  } else if (sub === "manifest") {
    await manifestCommand();
  } else if (sub === "launch-step") {
    await launchStep();
  } else if (sub === "run") {
    await runLifecycle();
  } else if (sub === "turn") {
    await turnDone();
  } else if (sub === "parent-ready") {
    await parentReady();
  } else if (sub === "escalate") {
    await escalate();
  } else if (sub === "deliver") {
    await deliver();
  } else if (sub === "escalate-human") {
    await escalateHuman();
  } else if (sub === "instruction") {
    await instruction();
  } else if (sub === "effect") {
    await effect();
  } else if (sub === "cost-hold") {
    await costHold();
  } else if (sub === "step") {
    if (rest[0] === "input") await stepInput();
    else if (rest[0] === "status") await stepStatus();
    else usage();
  } else usage();
}
