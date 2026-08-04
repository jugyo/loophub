import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.ts";
import { ServiceError } from "./errors.ts";

// Symlink-hardened writes under LOOPHUB_HOME, for the launch inputs LoopHub hands an agent as a
// file path (workflow contracts and prompts). The text is repo-private and the path is handed to a
// shell, so neither a directory on the way nor the file itself may be a symlink that redirects the
// write somewhere else.

function assertNotSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new ServiceError(
      422,
      `LoopHub home path must not be a symlink: ${path}`,
    );
  }
}

// Creates each missing segment of a directory under LOOPHUB_HOME, checking every level — an
// existing symlink anywhere on the way is refused rather than followed.
export function ensureHomeDir(...segments: string[]): string {
  let dir = configDir();
  for (const segment of segments) {
    dir = join(dir, segment);
    try {
      assertNotSymlink(dir);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      mkdirSync(dir);
      assertNotSymlink(dir);
    }
  }
  return dir;
}

export function writeHomeFile(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return path;
}
