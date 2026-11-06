import { join } from "node:path";
import { configDir, dbPath } from "../config.ts";
import { ServiceError } from "../errors.ts";
import { callHerdrCore } from "../herdr-core.ts";

// #2572: agents as herdr-core terminals. A terminal's address takes the place of a herdr pane id in
// what LoopHub records: agent_execution_targets (provider "herdr-core") for step agents, and
// herdr_panes (session_name "herdr-core") for a run's parent and New Issue agents.

export const HERDR_CORE_PROVIDER = "herdr-core";
export const HERDR_CORE_SESSION_NAME = "herdr-core";

// `t7`, `t1b`. A herdr pane id always carries its workspace (`w1:p2`), so the two never overlap.
const HERDR_CORE_ADDRESS = /^t[0-9a-z]+$/;

export function isHerdrCoreAddress(value: string): boolean {
  return HERDR_CORE_ADDRESS.test(value);
}

export type HerdrCoreRole =
  | "orchestrator"
  | "executor"
  | "verifier"
  | "issue-create"
  | "github-pr-export"
  | "supervisor";

export function herdrCoreLabels(input: {
  repo: string;
  role: HerdrCoreRole;
  pr?: number;
  run?: number;
  seq?: number;
  session?: string;
}): Record<string, string> {
  return {
    "loophub.repo": input.repo,
    "loophub.role": input.role,
    ...(input.pr === undefined ? {} : { "loophub.pr": String(input.pr) }),
    ...(input.run === undefined ? {} : { "loophub.run": String(input.run) }),
    ...(input.seq === undefined ? {} : { "loophub.seq": String(input.seq) }),
    ...(input.session === undefined
      ? {}
      : { "loophub.session": input.session }),
  };
}

export interface HerdrCoreLaunch {
  // Program, flags and the first prompt: a send to a booting agent can be dropped.
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  labels: Record<string, string>;
  // RuntimeDefinition.launchPromptNeedsSubmit: the runtime's TUI only pre-fills that prompt.
  submitPrompt?: boolean;
}

// What a terminal needs from the launcher rather than from the core, whose environment is that of
// whichever process happened to start it: where to find `lh` and the agent, and which LoopHub home
// its `lh` calls belong to. A DB that follows from that home is not passed: as an absolute path it
// would outlive a later change of LOOPHUB_HOME inside the terminal.
export function launcherEnv(): Record<string, string> {
  const home = configDir();
  const database = dbPath();
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    LOOPHUB_HOME: home,
    ...(database === join(home, "loophub.db") ? {} : { LOOPHUB_DB: database }),
  };
}

// A terminal's env is layered over the core's own and cannot remove a key: without `env -u`, a
// LOOPHUB_DB the core was started with would win over the launcher's LOOPHUB_HOME. `env` starts
// whether or not the program exists, so a program missing from PATH has to fail here, with the
// core's message. Without `hc` the call itself reports that, which is the error to fix first.
function withoutCoreDb(launch: HerdrCoreLaunch, path?: string): string[] {
  const [program = ""] = launch.argv;
  if (
    Bun.which("hc", { PATH: process.env.PATH }) &&
    !Bun.which(program, { PATH: path, cwd: launch.cwd })
  ) {
    throw new ServiceError(
      500,
      `herdr-core: cannot start "${program}": No such file or directory`,
      { kind: "spawn_failed", hint: "check the program name and cwd" },
    );
  }
  return ["env", "-u", "LOOPHUB_DB", ...launch.argv];
}

// Same hint and limit as the herdr launch (LAUNCH_PROMPT_READY_PATTERN): the wait only shortens the
// delay before Enter, which is pressed whatever it returns.
const PROMPT_READY_OUTPUT = "shift+tab";
const PROMPT_READY_TIMEOUT_SECONDS = 20;

// Starts the terminal and returns its address. No parent and no notes: instructions go through
// LoopHub's own delivery, and no `herdr.*` label keeps the terminal out of Herdr Desktop.
export async function launchHerdrCoreTerminal(
  launch: HerdrCoreLaunch,
): Promise<string> {
  const env = { ...launcherEnv(), ...launch.env };
  const started = (await callHerdrCore("terminal.run", {
    argv: "LOOPHUB_DB" in env ? launch.argv : withoutCoreDb(launch, env.PATH),
    cwd: launch.cwd,
    env,
    labels: launch.labels,
    no_parent: true,
    no_notify: true,
  })) as { address: string };
  if (launch.submitPrompt) {
    await callHerdrCore("terminal.wait", {
      terminal: started.address,
      output: PROMPT_READY_OUTPUT,
      timeout: PROMPT_READY_TIMEOUT_SECONDS,
    }).catch(() => {});
    try {
      await callHerdrCore("terminal.keys", {
        terminal: started.address,
        keys: ["enter"],
      });
    } catch (error) {
      // The caller records this launch as failed, so don't leave its agent running unrecorded.
      await killHerdrCoreTerminal(started.address).catch(() => {});
      throw error;
    }
  }
  return started.address;
}

// A blocked agent refuses the send (no `force`): nothing was typed, so the caller may deliver it
// again.
export async function sendToHerdrCoreTerminal(
  address: string,
  text: string,
): Promise<void> {
  await callHerdrCore("terminal.send", { terminal: address, text });
}

// Labels are the check on an address that came from outside: a crafted or stale one must not reach
// a terminal this repo (or PR, or role) did not start.
export async function assertHerdrCoreTerminalOwner(
  address: string,
  owner: { repo: string; pr?: number; role?: HerdrCoreRole },
): Promise<void> {
  const terminal = (await callHerdrCore("terminal.get", {
    terminal: address,
  })) as { labels?: Record<string, string> };
  if (
    terminal.labels?.["loophub.repo"] !== owner.repo ||
    (owner.pr !== undefined &&
      terminal.labels?.["loophub.pr"] !== String(owner.pr)) ||
    (owner.role !== undefined &&
      terminal.labels?.["loophub.role"] !== owner.role)
  ) {
    throw new ServiceError(
      409,
      `Terminal ${address} does not belong to ${owner.repo}${owner.pr === undefined ? "" : ` PR #${owner.pr}`}${owner.role === undefined ? "" : ` as ${owner.role}`}`,
    );
  }
}

type LabelledTerminal = {
  address: string;
  labels?: Record<string, string>;
};

export async function listHerdrCoreTerminals(): Promise<LabelledTerminal[]> {
  const listed = (await callHerdrCore("terminal.list", {})) as {
    terminals: LabelledTerminal[];
  };
  return listed.terminals;
}

export async function killHerdrCoreTerminal(
  address: string,
  repo?: string,
): Promise<void> {
  if (repo !== undefined) await assertHerdrCoreTerminalOwner(address, { repo });
  await callHerdrCore("terminal.kill", { terminal: address });
}
