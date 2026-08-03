import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

function hourKey(date: Date): string {
  return date.toISOString().slice(0, 13).replace("T", "-");
}

function hourlyPath(filePath: string, hour: string): string {
  const extension = extname(filePath);
  const stem = basename(filePath, extension);
  return join(dirname(filePath), `${stem}.${hour}${extension}`);
}

function pruneExpired(filePath: string, now: Date): void {
  const directory = dirname(filePath);
  const extension = extname(filePath);
  const stem = basename(filePath, extension);
  const prefix = `${stem}.`;
  const cutoff = hourKey(new Date(now.getTime() - LOG_RETENTION_MS));

  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(extension)) continue;
    const hour = entry.slice(prefix.length, entry.length - extension.length);
    if (!/^\d{4}-\d{2}-\d{2}-\d{2}$/.test(hour) || hour >= cutoff) continue;
    try {
      unlinkSync(join(directory, entry));
    } catch (error) {
      // Multiple processes may prune the same expired file concurrently.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export interface RotatingLogWriter {
  append(line: string, now?: Date): void;
  path(now?: Date): string;
}

// Write directly to UTC-hour files instead of renaming a shared current file. O_APPEND keeps
// concurrent process writes intact, and deriving the path from each line's timestamp prevents a
// stale writer from moving a newer line into an archive that is eligible for early deletion.
export function createRotatingLogWriter(filePath: string): RotatingLogWriter {
  let lastPrunedHour: string | undefined;
  let directoryReady = false;

  return {
    append(line, now = new Date()) {
      const nextHour = hourKey(now);
      const directory = dirname(filePath);
      if (!directoryReady) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        directoryReady = true;
      }
      if (lastPrunedHour !== nextHour) {
        pruneExpired(filePath, now);
        lastPrunedHour = nextHour;
      }
      appendFileSync(hourlyPath(filePath, nextHour), `${line}\n`, {
        mode: 0o600,
      });
    },
    path(now = new Date()) {
      return hourlyPath(filePath, hourKey(now));
    },
  };
}
