#!/usr/bin/env bun
// Single entry point for every LoopHub process, and the one `bun build --compile` compiles.
//
// The Bun runtime dominates a compiled binary's size, so shipping `lh`, `lh-web` and each worker
// separately would multiply it. They share one executable instead and pick a role at startup:
//
//   loophub <role> [args...]        e.g. `loophub lh issue list`, `loophub lh-web --port 8730`
//   <role> [args...]                when the executable is copied or hard-linked to the role name
//
// Each role module is a script that runs on import, so the role is selected by rewriting argv to
// what that module expects and then importing it.

const ROLES = {
  lh: () => import("../cli/index.ts"),
  "lh-web": () => import("../web/server/index.ts"),
  "lh-worker": () => import("../worker/index.ts"),
  "lh-watcher-git": () => import("../worker/git-watcher-index.ts"),
  "lh-watcher-github": () => import("../worker/github-watcher-index.ts"),
  "lh-watcher-agents": () => import("../worker/agents-watcher-index.ts"),
  "lh-dispatcher": () => import("../worker/dispatcher-index.ts"),
  "lh-job-queue": () => import("../worker/job-queue-index.ts"),
} as const;

type Role = keyof typeof ROLES;

function isRole(name: string | undefined): name is Role {
  return name !== undefined && name in ROLES;
}

// The name the executable was invoked under. A compiled binary reports its own path here, so a
// copy named `lh-web` runs that role with no extra argument; from the checkout this is `bun`.
function invokedName(): string {
  const base = process.execPath.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.exe$/i, "");
}

// An explicit role argument wins over the executable's name: `lh session usage sync` re-entered
// from a binary copied to `lh-web` must still run the CLI. No `lh` subcommand shares a name with a
// role, so this cannot swallow a CLI argument.
const [, , first, ...rest] = process.argv;
let role: Role;
let args: string[];
if (isRole(first)) {
  role = first;
  args = rest;
} else if (isRole(invokedName())) {
  role = invokedName() as Role;
  args = first === undefined ? [] : [first, ...rest];
} else if (first === "--roles") {
  process.stdout.write(`${Object.keys(ROLES).join("\n")}\n`);
  process.exit(0);
} else {
  process.stderr.write(
    `loophub: unknown role ${first ? `'${first}'` : "(none given)"}\n` +
      `Usage: loophub <role> [args...]\n` +
      `Roles: ${Object.keys(ROLES).join(", ")}\n`,
  );
  process.exit(1);
}

// The role modules read process.argv.slice(2), so leave argv shaped the way they would see it if
// they had been started directly.
process.argv = [process.argv[0], `${process.argv[0]} ${role}`, ...args];

await ROLES[role]();

// Only dynamic imports appear above, which would leave this a script rather than a module and
// disallow the top-level await.
export {};
