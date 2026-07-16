import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import { configDir } from "../core/config.ts";
import { flags } from "./args.ts";

// Lazily load the service layer (which opens the DB at import time) so DB-free commands
// like `lh` (usage) never touch ~/.loophub.
type Service = typeof import("../core/service.ts");
let _svc: Service | null = null;
export async function svc(): Promise<Service> {
  if (!_svc) _svc = await import("../core/service.ts");
  return _svc;
}

// Human CLI persists a default session; agents pass --session-id explicitly.
export const SESSION_ID =
  flags["session-id"] || flags.sessionId || process.env.LOOPHUB_SESSION_ID;
let humanSessionId: string | null = null;

function humanSessionPath() {
  return join(configDir(), "human-session.json");
}

// Resolve/create the persistent human session and ensure it's registered.
export async function ensureHumanSession(): Promise<string> {
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
export async function writeSession(): Promise<string> {
  if (SESSION_ID) return SESSION_ID;
  return ensureHumanSession();
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// One-word status label for a PR in `lh pr list` / `view` (#413). "draft" only applies to an open WIP
// PR — a draft closed before ready-for-review reads as "closed", not "draft" (mirrors the web
// draftBadge guard, which gates on `state === "open"`).
export function prStatusLabel(p: {
  merged?: boolean;
  draft?: boolean;
  state: string;
}): string {
  if (p.merged) return "merged";
  if (p.state === "open" && p.draft) return "draft";
  return p.state;
}

export function display(v: string): string {
  return stripVTControlCharacters(v).replace(/[\x00-\x1f\x7f]/g, "");
}

// Compact "2h ago" / "3d ago" style relative time for human-facing list output.
export function relativeTime(iso: string): string {
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
export async function run<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (typeof e?.status === "number") fail(`error ${e.status}: ${e.message}`);
    throw e;
  }
}

// --repo, LOOPHUB_REPO, or inferred from cwd.
export async function resolveRepo(): Promise<string> {
  if (flags.repo) return flags.repo;
  if (process.env.LOOPHUB_REPO) return process.env.LOOPHUB_REPO;
  const s = await svc();
  const repos = s.repos.list("all");
  const cwd = resolve(process.cwd());
  const hit = repos.find((r) => resolve(r.local_path) === cwd);
  if (hit) return hit.full_name;
  fail(
    "Cannot determine the repo. Pass --repo owner/name or run from the repo root.",
  );
}

export function out(v: any) {
  if (flags.json) console.log(JSON.stringify(v, null, 2));
  return v;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Yes/no prompt on the TTY for destructive confirmation; defaults to no on EOF or a blank line.
export async function confirm(question: string): Promise<boolean> {
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
