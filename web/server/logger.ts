// File logger for the lh-web backend. Unifies the server's diagnostics through a single leveled
// API: each call writes a timestamped, leveled line to the console AND appends it to a UTC-hour
// log file under `$LOOPHUB_HOME/logs/`. Files intersecting the previous 24 hours remain available
// after the process exits. Console routing follows the level — info -> stdout, warn/error ->
// stderr.
import { join } from "node:path";
import { logsDir } from "../../core/config.ts";
import { createRotatingLogWriter } from "../../core/rotating-log.ts";

const LOG_FILE = join(logsDir(), "lh-web.log");

export type LogLevel = "info" | "warn" | "error";

let fileDisabled = false;
const fileLog = createRotatingLogWriter(LOG_FILE);

function appendLine(line: string, now: Date): void {
  if (fileDisabled) return;
  try {
    fileLog.append(line, now);
  } catch {
    // A file-logging failure must never crash the server: drop file output, keep the console.
    fileDisabled = true;
  }
}

// Strip all C0 control characters and DEL from a message that may carry externally-influenced
// text (e.g. a git/network error routed through log.error). This both prevents forged extra log
// lines (CR/LF) and neutralizes terminal escape/control sequences (ESC, BEL, backspace) that
// could manipulate a terminal when the persisted log is later viewed with cat/tail. The flip
// side is that a multi-line stack trace collapses to one space-joined line — an accepted
// safety-over-readability tradeoff for a persisted, externally-viewable log.
function sanitize(message: string): string {
  return message.replace(/[\x00-\x1f\x7f]+/g, " ");
}

function write(level: LogLevel, message: string): void {
  const now = new Date();
  const line = `[${now.toISOString()}] ${level.toUpperCase()} ${sanitize(message)}`;
  // Preserve existing behavior: info -> stdout, warn/error -> stderr.
  if (level === "info") console.log(line);
  else console.error(line);
  appendLine(line, now);
}

export const log = {
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
};

// Exposed for tests / diagnostics.
export const logFilePath = (now = new Date()) => fileLog.path(now);
