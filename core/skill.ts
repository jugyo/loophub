import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Imported as text so the skill travels inside the compiled binary; there is no source tree to
// read it from there (see self-exec.ts).
import SKILL_MARKDOWN from "../skills/loophub/SKILL.md" with { type: "text" };
import { git } from "./git.ts";
import { CODING_AGENTS, type CodingAgent, RUNTIMES } from "./runtimes.ts";

// ===== the LoopHub skill =====
// One Agent Skills file (SKILL.md) written into a coding runtime's skills directory. The format is
// agent-neutral; only the directory differs per runtime, which is why the per-runtime path lives in
// runtimes.ts and this module only resolves and writes.
//
// The caller always names its target: one runtime, or "all". There is no implicit default, because
// writing to a runtime nobody asked for creates `~/.grok` or `~/.agents` on a machine that never
// runs it — and, under project scope, directories in the repository. Which runtimes are actually
// installed is deliberately not probed: LoopHub launches a runtime and lets a missing binary fail
// visibly rather than guessing from PATH.

export const SKILL_NAME = "loophub";
export const SKILL_FILENAME = "SKILL.md";
export const SKILL_MARKDOWN_TEXT = SKILL_MARKDOWN;

export type SkillScope = "user" | "project";

export interface SkillInstallInput {
  scope: SkillScope;
  cwd: string;
  // One runtime, or "all" for every runtime LoopHub can launch. Required — see above.
  runtime: CodingAgent | "all";
}

export interface SkillInstallEntry {
  // Every runtime served by this one file. Runtimes that share a directory share a write.
  runtimes: CodingAgent[];
  dir: string;
  path: string;
}

export interface SkillInstallResult {
  scope: SkillScope;
  bytes: number;
  installs: SkillInstallEntry[];
}

// `os.homedir()` caches the home at startup under Bun, so read HOME first — tests and wrappers
// redirect it (see AGENTS.md).
function userRoot(): string {
  return process.env.HOME || homedir();
}

// The repository's own root, at the git top level so running from a subdirectory installs once
// per repository rather than once per directory.
async function projectRoot(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = r.stdout.trim();
  if (r.code !== 0 || !root)
    throw new Error(
      `project scope needs a git repository at "${cwd}"; use --scope user instead`,
    );
  return root;
}

export async function skillTargets({
  scope,
  cwd,
  runtime,
}: SkillInstallInput): Promise<SkillInstallEntry[]> {
  const root = scope === "user" ? userRoot() : await projectRoot(cwd);
  const runtimes = runtime === "all" ? CODING_AGENTS : [runtime];
  const byDir = new Map<string, SkillInstallEntry>();
  for (const id of runtimes) {
    const dir = join(root, RUNTIMES[id].skillsDir, SKILL_NAME);
    const entry = byDir.get(dir);
    if (entry) entry.runtimes.push(id);
    else
      byDir.set(dir, {
        runtimes: [id],
        dir,
        path: join(dir, SKILL_FILENAME),
      });
  }
  return [...byDir.values()];
}

// Installing is a plain overwrite: re-running it is how an agent picks up a newer skill.
export async function installSkill(
  input: SkillInstallInput,
): Promise<SkillInstallResult> {
  const installs = await skillTargets(input);
  for (const { dir, path } of installs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, SKILL_MARKDOWN);
  }
  return {
    scope: input.scope,
    bytes: Buffer.byteLength(SKILL_MARKDOWN),
    installs,
  };
}
