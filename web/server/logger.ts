// File logger for the lh-web backend. Unifies the server's diagnostics through a single leveled
// API: each call writes a timestamped, leveled line to the console AND appends it to a log file
// under the repository's `logs/` directory (gitignored), so there is a persistent record after
// the process exits. Console routing follows the level — info -> stdout, warn/error -> stderr —
// which is why the startup banner (formerly console.error on stderr) now goes to stdout as info.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Repository root (web/server/ -> ../.. ). Resolved from this module's location rather than
// cwd so the log directory is stable regardless of where `lh-web` is launched from.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Default to the repo's gitignored `logs/`; LOOPHUB_WEB_LOG_DIR overrides it (used by tests).
const LOGS_DIR = process.env.LOOPHUB_WEB_LOG_DIR ?? join(REPO_ROOT, "logs");
const LOG_FILE = join(LOGS_DIR, "lh-web.log");

export type LogLevel = "info" | "warn" | "error";

// Create logs/ on first write so importing this module never touches the filesystem (keeps
// tests that import server modules side-effect-free) and the dir is auto-created at startup.
let dirReady = false;
let fileDisabled = false;

function appendLine(line: string): void {
  if (fileDisabled) return;
  try {
    if (!dirReady) {
      // Restrict to the owner: the file persists error messages / stack traces that may carry
      // repo paths or other sensitive context, and lh-web can be launched on shared hosts.
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
      dirReady = true;
    }
    appendFileSync(LOG_FILE, `${line}\n`, { mode: 0o600 });
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
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${sanitize(message)}`;
  // Preserve existing behavior: info -> stdout, warn/error -> stderr.
  if (level === "info") console.log(line);
  else console.error(line);
  appendLine(line);
}

export const log = {
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
};

// Exposed for tests / diagnostics.
export const logFilePath = LOG_FILE;
