// Terminal PTY domain logic. The web layer (web/server/terminal.ts) binds a WebSocket to one
// of these sessions; everything about *what* to spawn and *where* lives here so it stays
// reusable and unit-testable without a transport.
//
// Security: a session's cwd is resolved here from the repo's registered `local_path`. The
// client only ever names a repo ("owner/name") — it never passes a filesystem path — so a
// browser cannot point the shell at an arbitrary directory. Terminal access is otherwise
// unguarded by design (LoopHub is a local, single-user tool bound to loopback).
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { ServiceError } from "./errors.ts";
import * as S from "./store.ts";

// node-pty is a native addon. Load it through createRequire so bundler-based transformers
// (Vite/vitest) don't try to statically resolve/transform it — same rationale as core/db.ts
// loading node:sqlite. The require is lazy (inside createPtySession) so importing this module
// for the pure helpers (resolveShell/resolveRepoCwd, and their tests) never loads the addon.
const nodeRequire = createRequire(import.meta.url);

// Minimal shape of the bits of node-pty's IPty we use, so this file type-checks even before
// the optional @types are present and stays decoupled from the addon's full surface.
interface IPty {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface NodePty {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): IPty;
}

// Default terminal geometry before the client sends its first fit/resize.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// A live PTY session. One per WebSocket connection — the web layer never shares these, so
// adding multiple terminals (future tab feature) is just more connections, no change here.
export interface PtySession {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

// Pick the shell to spawn: explicit override, then the user's login shell, then a per-OS
// default. Pure so it can be unit-tested across platforms without spawning anything.
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.LOOPHUB_TERMINAL_SHELL?.trim()) return env.LOOPHUB_TERMINAL_SHELL;
  if (env.SHELL?.trim()) return env.SHELL;
  return platform === "win32" ? "powershell.exe" : "/bin/bash";
}

// Resolve a registered repo's base dir into a usable cwd. Throws ServiceError (404 unknown
// repo, 422 base dir gone) so the caller can map it to a transport-level rejection.
export function resolveRepoCwd(repoName: string): string {
  const [owner, name] = S.splitName(repoName);
  const repo = S.getRepo(owner, name);
  if (!repo) throw new ServiceError(404, `repo not found: ${repoName}`);
  let isDir = false;
  try {
    isDir = statSync(repo.local_path).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir)
    throw new ServiceError(
      422,
      `repo base dir is not a directory: ${repo.local_path}`,
    );
  return repo.local_path;
}

// Resolve the cwd for a terminal session. A named repo roots the shell at that repo's base dir
// (the repo-screen case); no repo — opened on a non-repo screen like the dashboard — roots it at
// the user's home directory. The repo is captured once when the session starts, so the cwd stays
// fixed for the life of the session regardless of later navigation.
export function resolveTerminalCwd(repo?: string | null): string {
  if (!repo?.trim()) return homedir();
  return resolveRepoCwd(repo);
}

export interface CreatePtyOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  shell?: string;
  env?: NodeJS.ProcessEnv;
}

// Spawn an interactive shell PTY rooted at `cwd`. The native addon is required lazily here.
export function createPtySession(opts: CreatePtyOptions): PtySession {
  const cols = opts.cols && opts.cols > 0 ? opts.cols : DEFAULT_COLS;
  const rows = opts.rows && opts.rows > 0 ? opts.rows : DEFAULT_ROWS;
  const baseEnv = opts.env ?? process.env;
  const shell = opts.shell ?? resolveShell(baseEnv);
  // TERM advertises a color-capable terminal; xterm.js renders 256-color output.
  const env = { ...baseEnv, TERM: "xterm-256color" };

  const pty = nodeRequire("node-pty") as NodePty;
  const proc = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env,
  });

  return {
    get pid() {
      return proc.pid;
    },
    onData: (cb) => {
      proc.onData(cb);
    },
    onExit: (cb) => {
      proc.onExit(cb);
    },
    write: (data) => proc.write(data),
    resize: (cols, rows) => {
      // node-pty throws on a zero/negative dimension; ignore degenerate sizes.
      if (cols > 0 && rows > 0) proc.resize(cols, rows);
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        // Already exited — killing a dead PTY throws on some platforms; nothing to do.
      }
    },
  };
}
