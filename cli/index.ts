import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { baseUrl, configDir, dbPath, worktreeRoot } from "../core/config.ts";
import { gitCommonDir, gitDirOf } from "../core/git.ts";
import {
  buildClaudeArgs,
  buildKaniLaunch,
  buildManagedSettings,
  displayMultiline,
  formatLaunchPlan,
  formatSpawnCommand,
  parseDevTarget,
  provisionWorktree,
  resolveAllowedDomains,
  validateRepo,
  worktreeBranch,
} from "./dev.ts";

// Lazily load the service layer (which opens the DB at import time) so DB-free commands
// like `lh` (usage) never touch ~/.loophub.
type Service = typeof import("../core/service.ts");
let _svc: Service | null = null;
async function svc(): Promise<Service> {
  if (!_svc) _svc = await import("../core/service.ts");
  return _svc;
}

// ---- arg parsing ----
// Declare each flag's type so boolean flags (--sandbox/--verbose/--json) never swallow the
// next token: `lh dev --sandbox 123` and `lh dev 123 --sandbox` parse identically, and
// `--repo=me/x` works. strict:false keeps the old lenient behavior for any undeclared flag.
type Flags = {
  repo?: string;
  "session-id"?: string;
  sessionId?: string;
  sandbox?: boolean;
  verbose?: boolean;
  kani?: boolean;
  json?: boolean;
  allow?: string;
  path?: string;
  name?: string;
  // string when a value is given (--archived all|true|false); boolean true when bare
  // (--archived), since strict:false resolves a value-less declared flag to true.
  archived?: string | boolean;
  "default-branch"?: string;
  state?: string;
  label?: string;
  title?: string;
  body?: string;
  id?: string;
  agent?: string;
  session?: string;
  head?: string;
  base?: string;
  issue?: string;
  method?: string;
  comments?: string;
  event?: string;
  since?: string;
  order?: string;
  add?: string;
  yes?: boolean;
  "dry-run"?: boolean;
  kind?: string;
  summary?: string;
  pr?: string;
  file?: string[];
  actor?: string;
};
const { values, positionals: pos } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    repo: { type: "string" },
    "session-id": { type: "string" },
    sessionId: { type: "string" },
    sandbox: { type: "boolean" },
    verbose: { type: "boolean" },
    kani: { type: "boolean" },
    json: { type: "boolean" },
    allow: { type: "string" },
    path: { type: "string" },
    name: { type: "string" },
    archived: { type: "string" },
    "default-branch": { type: "string" },
    state: { type: "string" },
    label: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    id: { type: "string" },
    agent: { type: "string" },
    session: { type: "string" },
    head: { type: "string" },
    base: { type: "string" },
    issue: { type: "string" },
    method: { type: "string" },
    comments: { type: "string" },
    event: { type: "string" },
    since: { type: "string" },
    order: { type: "string" },
    add: { type: "string" },
    yes: { type: "boolean" },
    "dry-run": { type: "boolean" },
    kind: { type: "string" },
    summary: { type: "string" },
    pr: { type: "string" },
    file: { type: "string", multiple: true },
    actor: { type: "string" },
  },
});
const flags = values as Flags;

// Human CLI persists a default session; agents pass --session-id explicitly.
const SESSION_ID = flags["session-id"] || flags.sessionId;
let humanSessionId: string | null = null;

function humanSessionPath() {
  return join(configDir(), "human-session.json");
}

// Resolve/create the persistent human session and ensure it's registered.
async function ensureHumanSession(): Promise<string> {
  if (humanSessionId) return humanSessionId;
  const path = humanSessionPath();
  let id: string;
  if (existsSync(path)) {
    id = JSON.parse(readFileSync(path, "utf8")).id;
  } else {
    id = randomUUID();
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ id, agent: "me", session: "cli" }, null, 2)}\n`,
    );
  }
  const s = await svc();
  s.sessions.register({ id, agent: "me", session: "cli" });
  humanSessionId = id;
  return id;
}

// Session id used to attribute a write: explicit --session-id, otherwise the human session.
async function writeSession(): Promise<string> {
  if (SESSION_ID) return SESSION_ID;
  return ensureHumanSession();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function display(v: string): string {
  return stripVTControlCharacters(v).replace(/[\x00-\x1f\x7f]/g, "");
}

// Compact "2h ago" / "3d ago" style relative time for human-facing list output.
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [Number.POSITIVE_INFINITY, "w"],
  ];
  let value = sec;
  for (const [size, label] of units) {
    if (value < size) return `${value}${label} ago`;
    value = Math.floor(value / size);
  }
  return `${value}w ago`;
}

// Run a service call, translating ServiceError (status + message) into the CLI error line.
async function run<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (typeof e?.status === "number") fail(`error ${e.status}: ${e.message}`);
    throw e;
  }
}

// --repo, or inferred from cwd.
async function resolveRepo(): Promise<string> {
  if (flags.repo) return flags.repo;
  const s = await svc();
  const repos = s.repos.list("all");
  const cwd = resolve(process.cwd());
  const hit = repos.find((r) => resolve(r.local_path) === cwd);
  if (hit) return hit.full_name;
  fail(
    "Cannot determine the repo. Pass --repo owner/name or run from the repo root.",
  );
}

function out(v: any) {
  if (flags.json) console.log(JSON.stringify(v, null, 2));
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Yes/no prompt on the TTY for destructive confirmation; defaults to no on EOF or a blank line.
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// ---- commands ----
const [group, sub, ...rest] = pos;

async function main() {
  if (group === "info") {
    // DB-free: report resolved environment so skills don't read ~/.loophub/config.json directly.
    const info = { baseUrl: baseUrl(), home: configDir(), dbPath: dbPath() };
    if (flags.json) out(info);
    else {
      console.log(`baseUrl\t${info.baseUrl}`);
      console.log(`home\t${info.home}`);
      console.log(`dbPath\t${info.dbPath}`);
    }
    return;
  }

  if (group === "dev" && sub === "log") {
    // Record a development note (decision/action/assumption/blocker) on the issue's PR.
    const logUsage =
      "usage: lh dev log --kind <decision|action|assumption|blocker> --summary <text> [--body <text>] [--issue <n>] [--pr <n>] [--repo owner/name]";
    if (!flags.kind || !flags.summary) fail(logUsage);
    if (!flags.issue && !flags.pr)
      fail(`--issue or --pr is required\n${logUsage}`);
    const repo = await resolveRepo();
    const s = await svc();
    const session = await writeSession();
    const note = await run(() =>
      s.dev.log(
        repo,
        {
          kind: flags.kind as string,
          summary: flags.summary as string,
          body: flags.body,
          issue: flags.issue ? Number(flags.issue) : undefined,
          pr: flags.pr ? Number(flags.pr) : undefined,
        },
        session,
      ),
    );
    if (flags.json) out(note);
    else {
      const target = note.pr_number
        ? `PR #${note.pr_number}`
        : `issue #${note.issue_number}`;
      console.log(`recorded ${note.kind} on ${target}: ${note.summary}`);
    }
    return;
  }

  if (group === "dev") {
    const target = sub;
    const usageLine =
      "usage: lh dev <owner>/<repo>/<id> | <id> [--repo owner/name] [--sandbox [--allow d1,d2]] [--verbose] [--kani]";
    if (!target) {
      fail(usageLine);
    }
    // Parse the positional: bare <id> defers repo resolution to resolveRepo(); the
    // <owner>/<repo>/<id> form carries the repo so `lh dev` can run from outside that repo.
    let parsed: { repo?: string; id: number };
    try {
      parsed = parseDevTarget(target);
    } catch (e: any) {
      fail(`${e.message}\n${usageLine}`);
    }
    // Resolve the repo: a repo from the positional takes precedence but must not contradict an
    // explicit --repo (a conflict is a hard error rather than a silent pick). Without a positional
    // repo, fall back to the existing resolution (--repo, else cwd match).
    let repo: string;
    if (parsed.repo) {
      if (flags.repo && flags.repo !== parsed.repo) {
        fail(
          `conflicting repo: positional '${parsed.repo}' vs --repo '${flags.repo}'`,
        );
      }
      repo = parsed.repo;
    } else {
      repo = await resolveRepo();
    }
    const n = parsed.id;
    const issue = String(n);
    const sessionId = randomUUID();
    const slashCommand = `/lh-dev ${issue}`;

    // Validate --allow vs --sandbox flag early.
    const useSandbox = flags.sandbox === true;
    if (flags.allow && !useSandbox) {
      fail("--allow can only be used with --sandbox");
    }

    // Validate --repo up front, before any side effects (provisioning a worktree).
    try {
      validateRepo(repo);
    } catch (e: any) {
      fail(e.message);
    }

    // When sandbox is enabled, validate --allow and log sandbox context.
    let allowedDomains: string[] | undefined;
    if (useSandbox) {
      try {
        allowedDomains = resolveAllowedDomains(flags.allow);
      } catch (e: any) {
        fail(e.message);
      }
      // Sandbox context (repo + allowed domains) to stderr only when sandbox enabled.
      console.error(`repo: ${repo}`);
      console.error(`allowed-domains: ${allowedDomains.join(", ")}`);
    }

    // Resolve the repo record + issue kind, then provision the worktree (outside the sandbox).
    const s = await svc();
    const r = await run(() => s.repos.get(repo));
    const item = await run(() => s.issues.get(repo, n));

    // --kani: relaunch the dev loop in a fresh kani terminal instead of the foreground. The
    // inner `lh dev` (without --kani) provisions the worktree and spawns claude itself, so we
    // do neither here — just launch the terminal and report its id. r.local_path is the main
    // checkout root the inner command resolves the repo from.
    if (flags.kani === true) {
      const launch = buildKaniLaunch({
        issue: n,
        title: item.title,
        cwd: r.local_path,
        flags: {
          // Forward the fully-resolved repo (not the raw --repo flag) so the inner `lh dev`
          // gets it explicitly regardless of which positional form launched this one.
          repo,
          sandbox: flags.sandbox,
          allow: flags.allow,
          verbose: flags.verbose,
        },
      });
      const proc = spawnSync("kani", launch.argv, { stdio: "inherit" });
      if (proc.error) {
        const err = proc.error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          fail("failed to launch kani terminal: 'kani' not found on PATH");
        }
        fail(`failed to launch kani terminal: ${err.message}`);
      }
      process.exit(proc.status ?? 0);
    }

    const headRef = item.pull_request
      ? (await run(() => s.pulls.get(repo, n))).head.ref
      : null;
    let worktree: string;
    try {
      worktree = await provisionWorktree({
        repoPath: r.local_path,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        worktreeRoot: worktreeRoot(),
        issue: n,
        headRef,
      });
    } catch (e: any) {
      fail(e.message);
    }

    // Display issue content before the launch plan so the user sees what they're about to work on.
    {
      let line = `#${item.number} ${display(item.title)} [${item.state}] @${display(item.user.login)}`;
      if (item.assignee) {
        const assigneeName = display(
          item.assignee.name || item.assignee.agent || "",
        );
        line += ` (assigned: @${assigneeName})`;
      }
      console.error(line);
      if (item.labels && item.labels.length > 0) {
        const labelNames = item.labels
          .map((l: any) => display(l.name))
          .join(", ");
        console.error(`labels: ${labelNames}`);
      }
      if (item.linked_pull_request) {
        const pr = item.linked_pull_request;
        console.error(
          `linked PR #${pr.number} (${pr.merged ? "merged" : display(pr.state)})`,
        );
      }
      console.error();
      console.error(displayMultiline(item.body));
      console.error();
    }

    // Build the sandbox managed-settings only when --sandbox is enabled.
    // When sandbox is disabled (default), managed will be undefined.
    let managed: string | undefined;
    if (useSandbox) {
      try {
        const [gitDir, worktreeGitDir] = await Promise.all([
          gitCommonDir(worktree),
          gitDirOf(worktree),
        ]);
        const branch = headRef ?? worktreeBranch(n);
        ({ json: managed } = buildManagedSettings({
          repo,
          allow: flags.allow,
          git: { gitDir, worktreeGitDir, branch },
        }));
      } catch (e: any) {
        fail(e.message);
      }
    }
    // Set the session display name to the issue so the session picker / terminal title shows
    // what's being worked on. buildClaudeArgs strips control chars from the title before argv.
    const sessionName = `#${item.number} ${item.title}`;
    const claudeArgs = buildClaudeArgs({
      sessionId,
      managedSettings: managed,
      slashCommand,
      sessionName,
    });

    // Show exactly what `claude` will receive, then launch immediately. The plan is a safety
    // artifact (what gets handed to `claude`); there is no confirmation prompt.
    console.error(
      formatLaunchPlan({
        repo,
        worktree,
        sessionId,
        slashCommand,
        managedSettings: managed ?? "{}",
        claudeArgs,
      }),
    );
    // Always show the exact command being spawned as the last line of the launch output, in
    // dim/gray, so a normal launch (no --verbose) still reveals and lets you copy what runs.
    // This supersedes the old --verbose-only `exec:` line — unified into one always-on display.
    // Built from `claudeArgs` (the same argv handed to spawnSync below) for an exact match.
    console.error(
      formatSpawnCommand(claudeArgs, { color: process.stderr.isTTY === true }),
    );

    // Make the work visible: register this session and assign the issue before spawning.
    // The runtime session id is the Claude session we are about to spawn (unique per run,
    // so re-launching the same issue never collides on the (agent, session) pair).
    await run(() =>
      s.sessions.register({
        id: sessionId,
        agent: "lh-dev",
        session: sessionId,
      }),
    );
    try {
      await s.issues.assign(repo, n, sessionId);
    } catch (e: any) {
      // A fresh session each run conflicts with a prior assignee on re-launch; reuse is
      // still valid (same worktree), so warn and continue rather than block the dev loop.
      if (e?.status === 409)
        console.error(
          `warning: issue #${issue} already assigned to another session; continuing`,
        );
      else if (typeof e?.status === "number")
        fail(`error ${e.status}: ${e.message}`);
      else throw e;
    }

    // Open a draft PR for the worktree branch so the agent can write its plan in the PR
    // body and attach dev notes to it. Idempotent (skips when an open PR already exists)
    // and best-effort: only for issues (not when working a PR), and a failure warns rather
    // than blocks the dev loop. The dev session is the actor.
    if (!item.pull_request) {
      try {
        const res = await s.dev.openPr(
          repo,
          {
            issue: n,
            head: worktreeBranch(n),
            base: r.default_branch,
          },
          sessionId,
        );
        console.error(
          res.created
            ? `draft PR #${res.number} opened`
            : `using existing PR #${res.number}`,
        );
      } catch (e: any) {
        console.error(`warning: could not open draft PR: ${e.message}`);
      }
    }

    const proc = spawnSync("claude", claudeArgs, {
      stdio: "inherit",
      cwd: worktree,
    });
    process.exit(proc.status ?? 0);
  }

  if (group === "repo") {
    const s = await svc();
    if (sub === "add") {
      const path = resolve(rest[0] || flags.path || process.cwd());
      const name = flags.name || `me/${path.split("/").pop()}`;
      const r = await run(() => s.repos.create({ path, name }));
      console.log(`added ${r.full_name}  (${r.local_path})`);
    } else if (sub === "list") {
      // Bare `--archived` resolves to boolean true under strict:false; treat it like the
      // old parser's "true" so `lh repo list --archived` still lists archived repos.
      const archived =
        flags.archived === "true" || flags.archived === true
          ? "archived"
          : flags.archived === "all"
            ? "all"
            : "active";
      const repos = s.repos.list(archived);
      out(repos);
      if (!flags.json)
        repos.forEach((r) => {
          console.log(
            `${r.archived ? "[archived] " : ""}${r.full_name}\t${r.local_path}`,
          );
        });
    } else if (sub === "archive" || sub === "unarchive") {
      const name = rest[0] || flags.repo;
      if (!name) fail("owner/name is required");
      const r = await run(async () =>
        s.repos.setArchived(name, sub === "archive", await writeSession()),
      );
      console.log(`${sub}d ${r.full_name}`);
    } else if (sub === "update") {
      const name = flags.repo || rest[0];
      if (!name)
        fail(
          "usage: lh repo update --repo owner/name [--default-branch main] [--path /abs/path]",
        );
      const fields: { default_branch?: string; local_path?: string } = {};
      if (flags["default-branch"])
        fields.default_branch = flags["default-branch"];
      if (flags.path) fields.local_path = resolve(flags.path);
      if (!fields.default_branch && !fields.local_path)
        fail("at least one of --default-branch or --path is required");
      const r = await run(() => s.repos.update(name, fields));
      console.log(
        `updated ${r.full_name}  default_branch=${r.default_branch}  (${r.local_path})`,
      );
    } else if (sub === "remove") {
      const name = flags.repo || rest[0];
      if (!name) fail("usage: lh repo remove --repo owner/name");
      await run(() => s.repos.remove(name));
      console.log(`removed ${name}`);
    } else usage();
    return;
  }

  if (group === "issue") {
    const s = await svc();
    const repo = await resolveRepo();
    if (sub === "list") {
      const state = flags.state || "open";
      const items = s.issues.list(repo, { state });
      const issues = items.filter((i: any) => !i.pull_request);
      out(issues);
      if (!flags.json)
        issues.forEach((i: any) => {
          const labels = (i.labels || []).map((l: any) => l.name).join(",");
          const assignee = i.assignee
            ? `@${display(i.assignee.name || i.assignee.agent || "")}`
            : "";
          console.log(
            `#${i.number}\t${i.state}\t${i.title}\t${labels}\t${assignee}\t${relativeTime(i.updated_at)}`,
          );
        });
    } else if (sub === "view") {
      const i = await run(() => s.issues.get(repo, Number(rest[0])));
      out(i);
      if (!flags.json) {
        let line = `#${i.number} ${i.title} [${i.state}] @${i.user.login}`;
        if (i.linked_pull_request) {
          const pr = i.linked_pull_request;
          line += `\nlinked PR #${pr.number} (${pr.merged ? "merged" : pr.state})`;
        }
        console.log(`${line}\n\n${i.body}`);
      }
    } else if (sub === "create") {
      const labels = (flags.label || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const i = await run(async () =>
        s.issues.create(
          repo,
          { title: flags.title ?? "", body: flags.body || "", labels },
          await writeSession(),
        ),
      );
      console.log(`created #${i.number}`);
    } else if (sub === "update") {
      const patch: { title?: string; body?: string } = {};
      if (flags.title !== undefined) patch.title = flags.title;
      if (flags.body !== undefined) patch.body = flags.body;
      if (Object.keys(patch).length === 0)
        fail("--title and/or --body is required");
      const i = await run(async () =>
        s.issues.update(repo, Number(rest[0]), patch, await writeSession()),
      );
      out(i);
      if (!flags.json) console.log(`updated #${i.number}`);
    } else if (sub === "comment") {
      await run(async () =>
        s.comments.create(
          repo,
          Number(rest[0]),
          flags.body ?? "",
          await writeSession(),
        ),
      );
      console.log("commented");
    } else if (sub === "assign") {
      if (!SESSION_ID) fail("--session-id is required");
      const i = await run(() =>
        s.issues.assign(repo, Number(rest[0]), SESSION_ID),
      );
      console.log(`assigned #${i.number} → ${i.assignee?.agent ?? SESSION_ID}`);
    } else if (sub === "unassign") {
      const i = await run(() =>
        s.issues.unassign(repo, Number(rest[0]), SESSION_ID || null),
      );
      console.log(`unassigned #${i.number}`);
    } else if (sub === "close") {
      await run(async () =>
        s.issues.update(
          repo,
          Number(rest[0]),
          { state: "closed" },
          await writeSession(),
        ),
      );
      console.log("closed");
    } else if (sub === "label") {
      const labels = (flags.add || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      await run(async () =>
        s.issues.addLabels(repo, Number(rest[0]), labels, await writeSession()),
      );
      console.log("labeled");
    } else usage();
    return;
  }

  if (group === "session") {
    const s = await svc();
    if (sub === "register") {
      const { id, agent, session } = flags;
      if (!id || !agent || !session)
        fail("--id, --agent, and --session are required");
      const { session: row } = await run(() =>
        s.sessions.register({
          id,
          agent,
          session,
          ...(flags.name ? { name: flags.name } : {}),
        }),
      );
      console.log(`registered session ${row.id} (${row.agent})`);
    } else if (sub === "list") {
      const rows = s.sessions.list();
      out(rows);
      if (!flags.json)
        rows.forEach((x: any) => {
          console.log(
            `${x.id}\t${x.agent}\t${x.session}${x.name ? `\t${x.name}` : ""}`,
          );
        });
    } else usage();
    return;
  }

  if (group === "attachment") {
    if (sub === "add") {
      // Files may be given as repeated --file flags and/or positionals.
      const paths = [...(flags.file ?? []), ...rest];
      if (paths.length === 0)
        fail(
          "usage: lh attachment add --file <path> [--file <path> ...] [--actor name]",
        );
      const { saveAttachment } = await import("../core/attachments.ts");
      // Standalone blobs aren't attributed to a session; default to the human "me".
      const author = flags.actor || "me";
      for (const p of paths) {
        const abs = resolve(p);
        if (!existsSync(abs)) fail(`file not found: ${p}`);
        const data = readFileSync(abs);
        const filename = abs.split("/").pop() || abs;
        const r = await run(() => saveAttachment({ data, filename, author }));
        if (flags.json) out(r);
        else {
          console.log(r.markdown);
          console.error(`uploaded ${filename} → ${r.url} (${r.size} bytes)`);
        }
      }
    } else usage();
    return;
  }

  if (group === "pr") {
    const s = await svc();
    const repo = await resolveRepo();
    if (sub === "list") {
      const items = await run(() =>
        s.pulls.list(repo, { state: flags.state || "open" }),
      );
      out(items);
      if (!flags.json)
        items.forEach((p: any) => {
          console.log(
            `#${p.number}\t${p.merged ? "merged" : p.state}\t${p.head.ref}->${p.base.ref}\t${p.title}`,
          );
        });
    } else if (sub === "view") {
      const p = await run(() => s.pulls.get(repo, Number(rest[0])));
      out(p);
      if (!flags.json) {
        let line = `#${p.number} ${p.title} [${p.merged ? "merged" : p.state}]\n${p.head.ref} -> ${p.base.ref}  mergeable=${p.mergeable_state}`;
        if (p.linked_issue)
          line += `\nlinked issue #${p.linked_issue.number} (${p.linked_issue.state})`;
        console.log(`${line}\n\n${p.body}`);
      }
    } else if (sub === "diff") {
      const files = await run(() => s.pulls.files(repo, Number(rest[0])));
      if (flags.json) out(files);
      else
        files.forEach((f: any) => {
          console.log(
            `--- ${f.filename} (+${f.additions} -${f.deletions})\n${f.patch}`,
          );
        });
    } else if (sub === "create") {
      const p = await run(async () =>
        s.pulls.create(
          repo,
          {
            title: flags.title ?? "",
            body: flags.body || "",
            head: flags.head ?? "",
            base: flags.base || "main",
            ...(flags.issue ? { issue: Number(flags.issue) } : {}),
          },
          await writeSession(),
        ),
      );
      console.log(`created PR #${p.number}`);
    } else if (sub === "update") {
      const patch: { title?: string; body?: string } = {};
      if (flags.title !== undefined) patch.title = flags.title;
      if (flags.body !== undefined) patch.body = flags.body;
      if (Object.keys(patch).length === 0)
        fail("--title and/or --body is required");
      const p = await run(async () =>
        s.pulls.update(repo, Number(rest[0]), patch, await writeSession()),
      );
      out(p);
      if (!flags.json) console.log(`updated PR #${p.number}`);
    } else if (sub === "merge") {
      const r = await run(async () =>
        s.pulls.merge(
          repo,
          Number(rest[0]),
          (flags.method || "squash") as any,
          await writeSession(),
        ),
      );
      console.log(`merged: ${r.sha}`);
    } else if (sub === "review") {
      let comments: any;
      if (flags.comments) {
        const raw =
          flags.comments === "-"
            ? await readStdin()
            : readFileSync(flags.comments, "utf8");
        comments = JSON.parse(raw); // [{ path, line, side?, body }, ...]
      }
      const res = await run(async () =>
        s.reviews.create(
          repo,
          Number(rest[0]),
          {
            event: (flags.event || "comment").toUpperCase(),
            body: flags.body || "",
            comments,
          },
          await writeSession(),
        ),
      );
      console.log(`review submitted (${res.comments} line comment(s))`);
    } else if (sub === "ready-for-review") {
      const p = await run(async () =>
        s.pulls.readyForReview(
          repo,
          Number(rest[0]),
          flags.body || "",
          await writeSession(),
        ),
      );
      console.log(
        `PR #${p.number} marked ready for re-review (${p.review_state})`,
      );
    } else if (sub === "close") {
      await run(async () =>
        s.pulls.update(
          repo,
          Number(rest[0]),
          { state: "closed" },
          await writeSession(),
        ),
      );
      console.log("closed");
    } else if (sub === "reopen") {
      await run(async () =>
        s.pulls.update(
          repo,
          Number(rest[0]),
          { state: "open" },
          await writeSession(),
        ),
      );
      console.log("reopened");
    } else usage();
    return;
  }

  if (group === "worktree") {
    if (sub !== "prune") {
      usage();
      return;
    }
    const s = await svc();
    const dryRun = flags["dry-run"] === true;
    const assumeYes = flags.yes === true;
    const repoFilter = flags.repo ?? null;

    // Scanning, issue/PR resolution and classification live in core (s.worktrees); the CLI only
    // presents, confirms, and reports.
    const entries = await run(() =>
      s.worktrees.plan({ repo: repoFilter, cwd: process.cwd() }),
    );
    const candidates = entries.filter((e) => e.action === "remove");
    const keep = entries.filter((e) => e.action === "keep");
    const skip = entries.filter((e) => e.action === "skip");

    if (flags.json) {
      out({ candidates, keep, skip, dryRun });
    } else {
      const fmt = (e: (typeof entries)[number]) =>
        `  ${e.repo}#${e.issue}\t${e.path}\t(${e.reason})`;
      console.log(`Remove candidates (${candidates.length}):`);
      for (const e of candidates) console.log(fmt(e));
      if (keep.length) {
        console.log(`\nKeep (${keep.length}):`);
        for (const e of keep) console.log(fmt(e));
      }
      if (skip.length) {
        console.log(`\nSkip (${skip.length}):`);
        for (const e of skip) console.log(fmt(e));
      }
    }

    if (dryRun) {
      if (!flags.json) console.log("\ndry-run: nothing removed.");
      return;
    }

    if (candidates.length === 0) {
      if (!flags.json) console.log("\nNothing to prune.");
      await s.worktrees.tidy(repoFilter); // still tidy stale admin entries
      return;
    }

    if (!assumeYes) {
      const ok = await confirm(`\nRemove ${candidates.length} worktree(s)?`);
      if (!ok) {
        if (!flags.json) console.log("aborted.");
        return;
      }
    }

    let removed = 0;
    for (const e of candidates) {
      const res = await s.worktrees.remove(e);
      if (res.removed) {
        removed++;
        if (!flags.json) console.log(`removed ${e.path}`);
      } else {
        console.error(`failed to remove ${e.path}: ${res.reason}`);
      }
    }

    await s.worktrees.tidy(repoFilter);
    if (!flags.json) console.log(`\nPruned ${removed} worktree(s).`);
    return;
  }

  if (group === "sync") {
    const s = await svc();
    const r = await s.sync.run();
    console.log(`updated ${r.updated} PR(s)`);
    return;
  }

  if (group === "events") {
    const s = await svc();
    const labels = (flags.label || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const evs = s.events.list({
      since: Number(flags.since || 0),
      repo: flags.repo || null,
      labels,
      order: flags.order === "desc" ? "desc" : "asc",
    });
    if (flags.json) out(evs);
    else
      evs.forEach((e) => {
        console.log(
          `${e.id}\t${e.type}\t${e.actor}\t${JSON.stringify(e.payload)}`,
        );
      });
    return;
  }

  usage();
}

function usage() {
  console.log(`lh — LoopHub CLI

  lh info [--json]                                 # resolved env: baseUrl (Web UI), home, dbPath
  lh dev <owner>/<repo>/<id> | <id> [--repo owner/name] [--sandbox [--allow d1,d2]] [--verbose] [--kani]   # start one issue in an interactive Claude session (--kani: in a new kani terminal)
  lh dev log --kind <decision|action|assumption|blocker> --summary <text> [--body <text>] [--issue <n>] [--pr <n>] [--repo owner/name]   # record a dev note on the issue's PR
  lh repo add <path> [--name owner/repo]
  lh repo list [--archived false|true|all]
  lh repo archive <owner/repo>   lh repo unarchive <owner/repo>
  lh repo update --repo owner/name [--default-branch main] [--path /abs/path]
  lh repo remove --repo owner/name
  lh session register --id <uuid> --agent <kind> --session <runtime-id> [--name "..."]
  lh session list
  lh issue list|view|create|update|comment|assign|unassign|close|label  [--repo owner/repo]
  lh pr list|view|diff|create|update|merge|review|ready-for-review|close|reopen  [--repo owner/repo]
  lh worktree prune [--repo owner/name] [--dry-run] [--yes]   # GC done lh-dev worktrees (issue closed / PR merged, clean tree)
  lh attachment add --file <path> [--file <path> ...] [--actor name]   # upload image(s), print embed markdown
  lh sync                                          # detect open-PR head updates and emit events
  lh events [--since <id>] [--repo owner/repo] [--label name[,name]] [--order asc|desc]

  common: --session-id <uuid>  --json
  examples:
    lh dev 42
    lh dev jugyo/loophub/42        # owner/repo/id form: start from outside the repo, no --repo needed
    lh dev --sandbox 42            # boolean flags and the issue id may appear in any order
    lh repo add . --name me/proj
    SID=$(uuidgen)
    lh session register --id "$SID" --agent impl-bot --session "$RUNTIME"
    lh issue assign 20 --session-id "$SID"
    lh issue create --title "do the thing" --label ready-to-build
    lh pr create --head feature-x --base main --title "impl" --issue 5
    lh pr merge 3 --method squash
    lh pr review 3 --event request_changes --body "please fix" --comments review.json
    echo '[{"path":"a.txt","line":2,"body":"typo"}]' | lh pr review 3 --comments -
    lh attachment add --file shot.png        # prints ![shot.png](/attachments/<sha256>)
    lh events --since 0`);
  process.exit(group ? 1 : 0);
}

main();
