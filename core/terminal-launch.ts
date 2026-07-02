import { createHash } from "node:crypto";

export type TerminalLaunchBackend = "builtin" | "herdr";

export interface TerminalLaunchRepo {
  full_name: string;
  local_path: string;
}

export interface HerdrLaunchPlan {
  sessionName: string;
  command: string;
  cwd: string;
  argv: string[];
}

export function normalizeTerminalLaunchBackend(
  value: unknown,
): TerminalLaunchBackend {
  return value === "herdr" ? "herdr" : "builtin";
}

function pathSafePart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

export function herdrSessionName(repo: TerminalLaunchRepo): string {
  const repoPart = repo.full_name.split("/").map(pathSafePart).join("-");
  const hash = createHash("sha256")
    .update(repo.full_name)
    .update("\0")
    .update(repo.local_path)
    .digest("hex")
    .slice(0, 8);
  return `${repoPart}-${hash}`;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandForHerdrLaunch(input: {
  repo: string;
  workflow?: "issue-dev" | "issue-create" | "resume" | "github-pr-export";
  issueNumber?: number;
  prNumber?: number;
  session?: string;
  cwd?: string;
}): string {
  if (input.workflow === "issue-dev" && input.issueNumber) {
    return `lh dev ${shellArg(`${input.repo}/${input.issueNumber}`)}`;
  }
  if (input.workflow === "issue-create") {
    // `lh issue new` is the recorded LoopHub entrypoint for the /lh-issue-create workflow.
    return `lh issue new --repo ${shellArg(input.repo)}`;
  }
  if (input.workflow === "github-pr-export" && input.prNumber) {
    return `claude ${shellArg(`/create-github-pr ${input.prNumber}`)}`;
  }
  if (input.workflow === "resume" && input.session) {
    const resume = `claude --resume ${shellArg(input.session)}`;
    return input.cwd ? `cd ${shellArg(input.cwd)} && ${resume}` : resume;
  }
  return "";
}

export function buildHerdrLaunchPlan(input: {
  repo: TerminalLaunchRepo;
  command: string;
  label?: string;
}): HerdrLaunchPlan {
  const sessionName = herdrSessionName(input.repo);
  const agentName = input.label || "LoopHub workflow";
  const argv = [
    "herdr",
    "--session",
    sessionName,
    "agent",
    "start",
    agentName,
    "--cwd",
    input.repo.local_path,
    "--no-focus",
    "--",
    "zsh",
    "-lc",
    input.command,
  ];
  return {
    sessionName,
    command: input.command,
    cwd: input.repo.local_path,
    argv,
  };
}
