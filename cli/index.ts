import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { configDir, worktreeRoot } from "../core/config.ts";
import { buildClaudeArgs, buildManagedSettings, provisionWorktree } from "./dev.ts";

// Lazily load the service layer (which opens the DB at import time) so DB-free commands
// like `lh` (usage) never touch ~/.loophub.
type Service = typeof import("../core/service.ts");
let _svc: Service | null = null;
async function svc(): Promise<Service> {
  return (_svc ??= await import("../core/service.ts"));
}

// ---- arg parsing ----
const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = "true";
    else {
      flags[key] = next;
      i++;
    }
  } else pos.push(a);
}

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
    writeFileSync(path, JSON.stringify({ id, agent: "me", session: "cli" }, null, 2) + "\n");
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
  fail("Cannot determine the repo. Pass --repo owner/name or run from the repo root.");
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

// Single-quote a value for the shell-pasteable `--verbose` exec line.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- commands ----
const [group, sub, ...rest] = pos;

async function main() {
  if (group === "dev") {
    const issue = sub;
    if (!issue || !/^[0-9]+$/.test(issue)) {
      fail("usage: lh dev <issue> [--repo owner/name] [--allow d1,d2] [--verbose]");
    }
    const repo = await resolveRepo();
    const n = Number(issue);
    const sessionId = randomUUID();
    let managed: string;
    let allowedDomains: string[];
    try {
      ({ json: managed, allowedDomains } = buildManagedSettings({ repo, allow: flags.allow }));
    } catch (e: any) {
      fail(e.message);
    }
    const slashCommand = `/loophub-dev ${issue}`;
    // Sandbox context (repo + allowed domains) always to stderr.
    console.error(`repo: ${repo}`);
    console.error(`allowed-domains: ${allowedDomains.join(", ")}`);

    // Resolve the repo record + issue kind, then provision the worktree (outside the sandbox).
    const s = await svc();
    const r = await run(() => s.repos.get(repo));
    const item = await run(() => s.issues.get(repo, n));
    const headRef = item.pull_request ? (await run(() => s.pulls.get(repo, n))).head.ref : null;
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
    console.error(`worktree: ${worktree}`);
    const claudeArgs = buildClaudeArgs({ sessionId, managedSettings: managed, slashCommand });
    if (flags.verbose === "true") {
      const claudeLine = `claude ${claudeArgs.map(shQuote).join(" ")}`;
      console.error(`exec: ${claudeLine}`);
    }

    // Make the work visible: register this session and assign the issue before spawning.
    // The runtime session id is the Claude session we are about to spawn (unique per run,
    // so re-launching the same issue never collides on the (agent, session) pair).
    await run(() => s.sessions.register({ id: sessionId, agent: "lh-dev", session: sessionId }));
    try {
      await s.issues.assign(repo, n, sessionId);
    } catch (e: any) {
      // A fresh session each run conflicts with a prior assignee on re-launch; reuse is
      // still valid (same worktree), so warn and continue rather than block the dev loop.
      if (e?.status === 409) console.error(`warning: issue #${issue} already assigned to another session; continuing`);
      else if (typeof e?.status === "number") fail(`error ${e.status}: ${e.message}`);
      else throw e;
    }

    console.error(`session-id: ${sessionId}`);
    const proc = spawnSync("claude", claudeArgs, { stdio: "inherit", cwd: worktree });
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
      const archived = flags.archived === "true" ? "archived" : flags.archived === "all" ? "all" : "active";
      const repos = s.repos.list(archived);
      out(repos);
      if (!flags.json)
        repos.forEach((r) => console.log(`${r.archived ? "[archived] " : ""}${r.full_name}\t${r.local_path}`));
    } else if (sub === "archive" || sub === "unarchive") {
      const name = rest[0] || flags.repo;
      if (!name) fail("owner/name is required");
      const r = await run(async () => s.repos.setArchived(name, sub === "archive", await writeSession()));
      console.log(`${sub}d ${r.full_name}`);
    } else if (sub === "update") {
      const name = flags.repo || rest[0];
      if (!name) fail("usage: lh repo update --repo owner/name [--default-branch main] [--path /abs/path]");
      const fields: { default_branch?: string; local_path?: string } = {};
      if (flags["default-branch"]) fields.default_branch = flags["default-branch"];
      if (flags.path) fields.local_path = resolve(flags.path);
      if (!fields.default_branch && !fields.local_path) fail("at least one of --default-branch or --path is required");
      const r = await run(() => s.repos.update(name, fields));
      console.log(`updated ${r.full_name}  default_branch=${r.default_branch}  (${r.local_path})`);
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
        issues.forEach((i: any) =>
          console.log(`#${i.number}\t${i.state}\t${i.title}\t${(i.labels || []).map((l: any) => l.name).join(",")}`),
        );
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
      const labels = (flags.label || "").split(",").map((x) => x.trim()).filter(Boolean);
      const i = await run(async () =>
        s.issues.create(repo, { title: flags.title, body: flags.body || "", labels }, await writeSession()),
      );
      console.log(`created #${i.number}`);
    } else if (sub === "update") {
      const patch: { title?: string; body?: string } = {};
      if (flags.title !== undefined) patch.title = flags.title;
      if (flags.body !== undefined) patch.body = flags.body;
      if (Object.keys(patch).length === 0) fail("--title and/or --body is required");
      const i = await run(async () => s.issues.update(repo, Number(rest[0]), patch, await writeSession()));
      out(i);
      if (!flags.json) console.log(`updated #${i.number}`);
    } else if (sub === "comment") {
      await run(async () => s.comments.create(repo, Number(rest[0]), flags.body, await writeSession()));
      console.log("commented");
    } else if (sub === "assign") {
      if (!SESSION_ID) fail("--session-id is required");
      const i = await run(() => s.issues.assign(repo, Number(rest[0]), SESSION_ID));
      console.log(`assigned #${i.number} → ${i.assignee?.agent ?? SESSION_ID}`);
    } else if (sub === "unassign") {
      const i = await run(() => s.issues.unassign(repo, Number(rest[0]), SESSION_ID || null));
      console.log(`unassigned #${i.number}`);
    } else if (sub === "close") {
      await run(async () => s.issues.update(repo, Number(rest[0]), { state: "closed" }, await writeSession()));
      console.log("closed");
    } else if (sub === "label") {
      const labels = (flags.add || "").split(",").map((x) => x.trim()).filter(Boolean);
      await run(async () => s.issues.addLabels(repo, Number(rest[0]), labels, await writeSession()));
      console.log("labeled");
    } else usage();
    return;
  }

  if (group === "session") {
    const s = await svc();
    if (sub === "register") {
      const { id, agent, session } = flags;
      if (!id || !agent || !session) fail("--id, --agent, and --session are required");
      const { session: row } = await run(() =>
        s.sessions.register({ id, agent, session, ...(flags.name ? { name: flags.name } : {}) }),
      );
      console.log(`registered session ${row.id} (${row.agent})`);
    } else if (sub === "list") {
      const rows = s.sessions.list();
      out(rows);
      if (!flags.json)
        rows.forEach((x: any) => console.log(`${x.id}\t${x.agent}\t${x.session}${x.name ? `\t${x.name}` : ""}`));
    } else usage();
    return;
  }

  if (group === "pr") {
    const s = await svc();
    const repo = await resolveRepo();
    if (sub === "list") {
      const items = await run(() => s.pulls.list(repo, { state: flags.state || "open" }));
      out(items);
      if (!flags.json)
        items.forEach((p: any) =>
          console.log(`#${p.number}\t${p.merged ? "merged" : p.state}\t${p.head.ref}->${p.base.ref}\t${p.title}`),
        );
    } else if (sub === "view") {
      const p = await run(() => s.pulls.get(repo, Number(rest[0])));
      out(p);
      if (!flags.json) {
        let line = `#${p.number} ${p.title} [${p.merged ? "merged" : p.state}]\n${p.head.ref} -> ${p.base.ref}  mergeable=${p.mergeable_state}`;
        if (p.linked_issue) line += `\nlinked issue #${p.linked_issue.number} (${p.linked_issue.state})`;
        console.log(`${line}\n\n${p.body}`);
      }
    } else if (sub === "diff") {
      const files = await run(() => s.pulls.files(repo, Number(rest[0])));
      if (flags.json) out(files);
      else files.forEach((f: any) => console.log(`--- ${f.filename} (+${f.additions} -${f.deletions})\n${f.patch}`));
    } else if (sub === "create") {
      const p = await run(async () =>
        s.pulls.create(
          repo,
          {
            title: flags.title,
            body: flags.body || "",
            head: flags.head,
            base: flags.base || "main",
            ...(flags.issue ? { issue: Number(flags.issue) } : {}),
          },
          await writeSession(),
        ),
      );
      console.log(`created PR #${p.number}`);
    } else if (sub === "merge") {
      const r = await run(async () =>
        s.pulls.merge(repo, Number(rest[0]), (flags.method || "squash") as any, await writeSession()),
      );
      console.log(`merged: ${r.sha}`);
    } else if (sub === "review") {
      let comments: any = undefined;
      if (flags.comments) {
        const raw = flags.comments === "-" ? await readStdin() : readFileSync(flags.comments, "utf8");
        comments = JSON.parse(raw); // [{ path, line, side?, body }, ...]
      }
      const res = await run(async () =>
        s.reviews.create(
          repo,
          Number(rest[0]),
          { event: (flags.event || "comment").toUpperCase(), body: flags.body || "", comments },
          await writeSession(),
        ),
      );
      console.log(`review submitted (${res.comments} line comment(s))`);
    } else if (sub === "ready-for-review") {
      const p = await run(async () =>
        s.pulls.readyForReview(repo, Number(rest[0]), flags.body || "", await writeSession()),
      );
      console.log(`PR #${p.number} marked ready for re-review (${p.review_state})`);
    } else if (sub === "close") {
      await run(async () => s.pulls.update(repo, Number(rest[0]), { state: "closed" }, await writeSession()));
      console.log("closed");
    } else if (sub === "reopen") {
      await run(async () => s.pulls.update(repo, Number(rest[0]), { state: "open" }, await writeSession()));
      console.log("reopened");
    } else usage();
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
    const labels = (flags.label || "").split(",").map((x) => x.trim()).filter(Boolean);
    const evs = s.events.list({
      since: Number(flags.since || 0),
      repo: flags.repo || null,
      labels,
      order: flags.order === "desc" ? "desc" : "asc",
    });
    if (flags.json) out(evs);
    else evs.forEach((e) => console.log(`${e.id}\t${e.type}\t${e.actor}\t${JSON.stringify(e.payload)}`));
    return;
  }

  usage();
}

function usage() {
  console.log(`lh — LoopHub CLI

  lh dev <issue> [--repo owner/name] [--allow d1,d2] [--verbose]   # start one issue in an interactive Claude session
  lh repo add <path> [--name owner/repo]
  lh repo list [--archived false|true|all]
  lh repo archive <owner/repo>   lh repo unarchive <owner/repo>
  lh repo update --repo owner/name [--default-branch main] [--path /abs/path]
  lh repo remove --repo owner/name
  lh session register --id <uuid> --agent <kind> --session <runtime-id> [--name "..."]
  lh session list
  lh issue list|view|create|update|comment|assign|unassign|close|label  [--repo owner/repo]
  lh pr list|view|diff|create|merge|review|ready-for-review|close|reopen  [--repo owner/repo]
  lh sync                                          # detect open-PR head updates and emit events
  lh events [--since <id>] [--repo owner/repo] [--label name[,name]] [--order asc|desc]

  common: --session-id <uuid>  --json
  examples:
    lh dev 42
    lh repo add . --name me/proj
    SID=$(uuidgen)
    lh session register --id "$SID" --agent impl-bot --session "$RUNTIME"
    lh issue assign 20 --session-id "$SID"
    lh issue create --title "do the thing" --label ready-to-build
    lh pr create --head feature-x --base main --title "impl" --issue 5
    lh pr merge 3 --method squash
    lh pr review 3 --event request_changes --body "please fix" --comments review.json
    echo '[{"path":"a.txt","line":2,"body":"typo"}]' | lh pr review 3 --comments -
    lh events --since 0`);
  process.exit(group ? 1 : 0);
}

main();
