// #2350: In-process cache for git commands whose output is a function of their arguments alone.
//
// Web, CLI and worker re-render the same issue and PR views constantly, and every render asks git
// the same questions about the same commits: `git diff <sha>...<sha>`, `git log <sha> --not <sha>`,
// `git show <sha>:<path>`. Once every revision an invocation names is a resolved commit SHA the
// answer cannot change — git objects are immutable — so re-running the command spawns a subprocess
// only to recompute a byte-identical result.
//
// An invocation is cached only when all of the following hold:
//   - the subcommand is one of CACHEABLE_SUBCOMMANDS (read-only, no working-tree or index writes);
//   - every argument starting with `-` is a flag this module has explicitly cleared for that
//     subcommand, spelled exactly as the table declares (see CACHEABLE_SUBCOMMANDS);
//   - every revision operand is resolved (a full SHA, plus `^`/`~` suffixes, which are fixed once
//     the starting commit is) — a branch name, `HEAD`, or a missing operand would let a ref move or
//     a working-tree edit change the output;
//   - the caller passes no per-invocation env overrides, which can change what git does;
//   - the command succeeded — a failure can turn into a success once the object is fetched.
//
// Argument classification fails closed on purpose. Every unrecognised argument — an unknown flag, an
// unexpected spelling, a flag value we cannot vouch for — makes the invocation uncacheable, so a
// mistake here costs a subprocess rather than serving a stale answer. Adding a flag to the table
// below is the one place where that safety can be given away, so an entry belongs there only once
// its output is known to depend on nothing but the objects the operands name.
//
// Entries simply expire after TTL_MS. There is deliberately no invalidation hook: correctness comes
// from caching immutable inputs only, and the TTL bounds how long a misclassification — or a `git
// gc` that drops an object the cached run could still read — stays observable.

import type { GitResult } from "./git.ts";
import { logDiagnostic } from "./slow-operation.ts";

/** How long a cached result stays usable. */
export const TTL_MS = 60_000;

// Bounded so a resident process cannot accumulate every diff it has ever rendered. Patches dominate
// the footprint, so the budget is over output bytes rather than entry count; eviction is oldest
// first, which is also roughly expiry order because every entry gets the same TTL.
export const MAX_CACHED_BYTES = 32 * 1024 * 1024;

// How a cleared flag carries its value:
//   "none"      the flag takes no value, so `--flag=anything` is rejected;
//   a predicate the value must be attached as `--flag=<value>` and satisfy the predicate.
// There is deliberately no "value in the next argument" form. A flag spelled `--max-count 5` leaves
// `5` looking like an operand, which fails the revision check — so no argument can ever be consumed
// as a flag value by mistake, and no flag value can ever be mistaken for a revision.
type FlagValue = "none" | ((value: string) => boolean);

const DIGITS = (value: string): boolean => /^\d+$/.test(value);
const DIFF_FILTER_LETTERS = (value: string): boolean => /^[a-z]+$/i.test(value);

// Pretty-format placeholders that render fields of the commit object itself, which is fixed once the
// commit is. Everything else is rejected, including `%d`/`%D` (ref decorations move), `%ar`/`%ch`
// and the rest of the relative-date family (rendered against the current time), `%aN`/`%cE` (read
// `.mailmap` out of the working tree) and `%N` (notes live in a mutable ref).
// Matched case-sensitively: git's placeholders differ by case, and it is the uppercase spellings
// (`%aN`, `%cE`, `%D`, `%N`) that reach outside the commit object.
const COMMIT_ONLY_FORMAT = (value: string): boolean =>
  /^(?:[^%]|%(?:x[0-9a-fA-F]{2}|%|n|[HhTtPpsfbB]|a[eIt]|c[eIt]|an|cn))*$/.test(
    value,
  );

// Read-only subcommands whose output is determined by the objects their operands name, each with
// the flags cleared for it. `rev-parse`, `status` and the worktree subcommands are deliberately
// absent: they report where refs and the working tree currently are, which must stay live.
const CACHEABLE_SUBCOMMANDS = new Map<string, Map<string, FlagValue>>([
  [
    "diff",
    new Map<string, FlagValue>([
      ["--diff-filter", DIFF_FILTER_LETTERS],
      ["--ignore-all-space", "none"],
      ["--name-only", "none"],
      ["--no-renames", "none"],
      ["--numstat", "none"],
      ["--raw", "none"],
      ["-z", "none"],
    ]),
  ],
  [
    "log",
    new Map<string, FlagValue>([
      ["--format", COMMIT_ONLY_FORMAT],
      ["--max-count", DIGITS],
      ["--not", "none"],
    ]),
  ],
  ["merge-base", new Map<string, FlagValue>()],
  [
    "rev-list",
    new Map<string, FlagValue>([
      ["--count", "none"],
      ["--not", "none"],
      ["--parents", "none"],
    ]),
  ],
  ["show", new Map<string, FlagValue>()],
]);

// A revision already resolved to one commit: a full SHA, optionally followed by ancestor suffixes
// (`^`, `^2`, `~3`) that are themselves fixed once the starting commit is.
const RESOLVED_REVISION = /^[0-9a-f]{40}(?:[\^~]\d*)*$/i;

// Whether one `-…` argument is cleared for this subcommand. Lookups go through a Map rather than a
// plain object so that an argument naming an inherited property (`--constructor=x`) cannot resolve
// to something truthy.
function isCachedFlag(flags: Map<string, FlagValue>, flag: string): boolean {
  const separator = flag.indexOf("=");
  const name = separator === -1 ? flag : flag.slice(0, separator);
  const value = flags.get(name);
  if (value === undefined) return false;
  if (value === "none") return separator === -1;
  return separator !== -1 && value(flag.slice(separator + 1));
}

// Endpoints named by one operand: `a..b` and `a...b` name two, a bare revision one. Returns null
// when any of them is unresolved, which makes the whole invocation uncacheable.
function endpointsOf(operand: string): number | null {
  const parts = operand.includes("...")
    ? operand.split("...")
    : operand.split("..");
  if (parts.length > 2) return null;
  if (!parts.every((part) => RESOLVED_REVISION.test(part))) return null;
  return parts.length;
}

// `git show` takes objects rather than ranges: `<rev>` or `<rev>:<path>`.
function isResolvedObject(operand: string): boolean {
  const colon = operand.indexOf(":");
  return RESOLVED_REVISION.test(
    colon === -1 ? operand : operand.slice(0, colon),
  );
}

function operandsAreImmutable(subcommand: string, operands: string[]): boolean {
  if (subcommand === "show")
    return operands.length > 0 && operands.every(isResolvedObject);

  let endpoints = 0;
  for (const operand of operands) {
    const count = endpointsOf(operand);
    if (count === null) return false;
    endpoints += count;
  }
  // `git diff <rev>` compares against the working tree, and every one of these subcommands falls
  // back to HEAD with no operand at all.
  if (subcommand === "diff") return endpoints === 2;
  if (subcommand === "merge-base") return endpoints >= 2;
  return endpoints >= 1;
}

/** Cache key for an invocation whose output cannot change, or null when it must run every time. */
export function immutableGitKey(
  repoPath: string,
  args: string[],
  env: Record<string, string> = {},
): string | null {
  if (Object.keys(env).length > 0) return null;
  const [subcommand, ...rest] = args;
  const flags = CACHEABLE_SUBCOMMANDS.get(subcommand);
  if (!flags) return null;

  const operands: string[] = [];
  for (const arg of rest) {
    if (arg === "--") break; // the remainder is a pathspec, which only filters the output
    if (arg.startsWith("-")) {
      if (!isCachedFlag(flags, arg)) return null;
      continue;
    }
    operands.push(arg);
  }
  if (!operandsAreImmutable(subcommand, operands)) return null;
  // JSON rather than a joined string: the encoding is unambiguous whatever the arguments contain,
  // so no two different invocations can collide on one key.
  return JSON.stringify([repoPath, ...args]);
}

interface CacheEntry {
  expiresAt: number;
  result: Promise<GitResult>;
  bytes: number; // 0 until the command resolves; an in-flight entry is never evicted for size
}

const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function drop(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cachedBytes -= entry.bytes;
  cache.delete(key);
}

function evictToBudget(): void {
  for (const [key, entry] of cache) {
    if (cachedBytes <= MAX_CACHED_BYTES) return;
    if (entry.bytes === 0) continue;
    drop(key);
  }
}

/**
 * Return the result of `run`, reusing a live cached result when this invocation is immutable.
 *
 * The in-flight promise is cached, so concurrent callers asking the same question (the same PR
 * rendered in two lists) share one subprocess. Failures are evicted on resolution.
 */
export function cachedGitResult(
  repoPath: string,
  args: string[],
  env: Record<string, string>,
  run: () => Promise<GitResult>,
): Promise<GitResult> {
  const key = immutableGitKey(repoPath, args, env);
  if (key === null) return run();

  const startedAt = Date.now();
  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > startedAt) {
      // Whether the cache is serving anything is otherwise invisible from outside the process. The
      // command is spelled as the argv spawnGit would have run, so a hit names the invocation it
      // stood in for.
      logDiagnostic(
        () =>
          `[git-cache] event=hit command=${JSON.stringify(["git", "-C", repoPath, ...args])}`,
      );
      return hit.result;
    }
    drop(key);
  }

  const result = run();
  const entry: CacheEntry = { expiresAt: startedAt + TTL_MS, result, bytes: 0 };
  cache.set(key, entry);
  result.then(
    (value) => {
      if (cache.get(key) !== entry) return;
      if (value.code !== 0) {
        drop(key);
        return;
      }
      entry.bytes = value.stdout.length + value.stderr.length;
      cachedBytes += entry.bytes;
      evictToBudget();
    },
    () => {
      if (cache.get(key) === entry) drop(key);
    },
  );
  return result;
}

/** Test-only: drop all cached results so a test starts from a cold cache. */
export function clearGitResultCache(): void {
  cache.clear();
  cachedBytes = 0;
}
