import { agentEffort, agentModel } from "../../core/config.ts";
import { spawnSyncProcess } from "../../core/process.ts";
import { buildRuntimeArgs, runtimePrompt } from "../../core/runtime-args.ts";
import {
  type CodingAgent,
  isCodingAgent,
  RUNTIMES,
} from "../../core/runtimes.ts";
import { writeLaunchPrompt } from "../../core/terminal/launch-prompt.ts";
import {
  agentCommandLine,
  herdrAgentFocusArgv,
  herdrTabFocusArgv,
} from "../../core/terminal/terminal-launch.ts";
import { workflowContractText } from "../../core/workflow/contracts.ts";
import { flags, rest, sub } from "../args.ts";
import { display, fail, resolveRepo, run as runOp, svc } from "../context.ts";
import {
  HerdrLaunchError,
  type HerdrLaunchResult,
  launchAgentInWorktreeHerdr,
} from "../herdr-launch.ts";
import { readTextInput } from "../text-input.ts";
import { usage } from "../usage.ts";

const USAGE =
  "usage: lh supervisor start --runtime <runtime> --prompt <text|@file|-> [--repo owner/name] [--herdr]";

function runtimeFlag(): CodingAgent {
  if (typeof flags.runtime !== "string" || !flags.runtime.trim())
    fail("--runtime is required");
  if (!isCodingAgent(flags.runtime)) {
    fail(`--runtime must be one of: ${Object.keys(RUNTIMES).join(", ")}`);
  }
  return flags.runtime;
}

async function promptFlag(): Promise<string> {
  if (typeof flags.prompt !== "string") fail("--prompt is required");
  const prompt = await readTextInput(flags.prompt);
  if (!prompt.trim()) fail("--prompt must not be empty");
  return prompt;
}

function launchArgs(input: {
  runtime: CodingAgent;
  prompt: string;
  contract: string;
  contractPath?: string;
}): string[] {
  return buildRuntimeArgs({
    runtime: input.runtime,
    model: agentModel(input.runtime),
    effort: agentEffort(input.runtime),
    systemPrompt: input.contract,
    systemPromptFile: input.contractPath,
    prompt: input.prompt,
  });
}

async function startSupervisor(): Promise<void> {
  if (sub !== "start" || rest.length > 0) fail(USAGE);

  const runtime = runtimeFlag();
  const prompt = await promptFlag();
  const repoName = await resolveRepo();
  const s = await svc();
  const repo = await runOp(() => s.repos.get(repoName));
  const language = s.settings.get().workflowContractLanguage;
  const contract = workflowContractText("supervisor", language);
  const runtimeContractPath =
    runtime === "claude-code" ? writeLaunchPrompt(contract) : undefined;
  const args = launchArgs({
    runtime,
    prompt,
    contract,
    contractPath: runtimeContractPath,
  });

  if (flags.herdr === true) {
    const promptPath = writeLaunchPrompt(
      runtimePrompt({
        runtime,
        systemPrompt: contract,
        prompt,
      }),
    );
    const command = agentCommandLine({
      bin: RUNTIMES[runtime].bin,
      args: args.slice(0, -1),
      promptPath,
    });
    let launched: HerdrLaunchResult;
    try {
      launched = await launchAgentInWorktreeHerdr({
        repo: { full_name: repo.full_name, local_path: repo.local_path },
        worktree: repo.local_path,
        command,
        label: "Supervisor",
      });
    } catch (error) {
      if (error instanceof HerdrLaunchError) fail(error.message);
      throw error;
    }
    if (launched.tabId) {
      spawnSyncProcess(herdrTabFocusArgv(repo, launched.tabId), {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } else if (launched.paneId) {
      spawnSyncProcess(herdrAgentFocusArgv(repo, launched.paneId), {
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
    console.error(
      `Supervisor を herdr pane ${display(launched.paneId ?? "unknown")} で起動しました。Attach: herdr session attach ${launched.sessionName}`,
    );
    return;
  }

  const proc = spawnSyncProcess([RUNTIMES[runtime].bin, ...args], {
    cwd: repo.local_path,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.error) {
    const error = proc.error as NodeJS.ErrnoException;
    if (error.code === "ENOENT")
      fail(
        `failed to launch ${RUNTIMES[runtime].bin}: '${RUNTIMES[runtime].bin}' not found on PATH`,
      );
    fail(`failed to launch ${RUNTIMES[runtime].bin}: ${error.message}`);
  }
  if (proc.signalCode)
    fail(
      `failed to launch ${RUNTIMES[runtime].bin}: terminated by signal ${proc.signalCode}`,
    );
  process.exit(proc.exitCode ?? 1);
}

export async function run(): Promise<void> {
  if (sub !== "start") {
    usage();
    return;
  }
  await startSupervisor();
}
