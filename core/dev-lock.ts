import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface DevLock {
  pid: number;
  pr: number;
  worktree: string;
  sessionId: string;
  startedAt: string;
}

export type AcquireDevLock = { ok: true } | { ok: false; held: DevLock };

export function devLockPath(
  home: string,
  fullName: string,
  pr: number,
): string {
  return join(realpathSync(home), "dev-locks", fullName, `pr-${pr}.json`);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export function acquireDevLock(
  path: string,
  lock: DevLock,
  isAlive: (pid: number) => boolean,
  opts: { force?: boolean } = {},
): AcquireDevLock {
  ensureDirectoryNoSymlink(dirname(path));
  const data = `${JSON.stringify(lock, null, 2)}\n`;
  try {
    writeLockNoFollow(path, data, true);
    return { ok: true };
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
  const existing = readDevLock(path);
  if (!opts.force && existing && isAlive(existing.pid)) {
    return { ok: false, held: existing };
  }
  assertNotSymlink(path);
  writeLockNoFollow(path, data, false);
  return { ok: true };
}

export function readDevLock(path: string): DevLock | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (
      v &&
      Number.isInteger(v.pid) &&
      typeof v.pr === "number" &&
      typeof v.worktree === "string" &&
      typeof v.sessionId === "string" &&
      typeof v.startedAt === "string"
    ) {
      return v as DevLock;
    }
    return null;
  } catch {
    return null;
  }
}

export function removeDevLock(path: string): void {
  try {
    assertParentsNotSymlink(dirname(path));
    rmSync(path);
  } catch {}
}

function assertNotSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`dev lock path must not be a symlink: ${path}`);
  }
}

function ensureDirectoryNoSymlink(path: string): void {
  const parts = path.split("/");
  let current = path.startsWith("/") ? "/" : ".";
  for (const part of parts) {
    if (!part) continue;
    current = current === "/" ? `/${part}` : join(current, part);
    try {
      assertNotSymlink(current);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      mkdirSync(current);
      assertNotSymlink(current);
    }
  }
}

function assertParentsNotSymlink(path: string): void {
  const parts = path.split("/");
  let current = path.startsWith("/") ? "/" : ".";
  for (const part of parts) {
    if (!part) continue;
    current = current === "/" ? `/${part}` : join(current, part);
    assertNotSymlink(current);
  }
}

function writeLockNoFollow(
  path: string,
  data: string,
  exclusive: boolean,
): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : constants.O_TRUNC),
    0o600,
  );
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}
