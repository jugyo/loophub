import { join } from "node:path";
import { logsDir } from "../core/config.ts";
import { createRotatingLogWriter } from "../core/rotating-log.ts";

export function sanitizeWorkerLogMessage(message: string): string {
  return message.replace(/[\x00-\x1f\x7f]+/g, " ");
}

export function workerErrorDetail(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

let fileDisabled = false;
const fileLog = createRotatingLogWriter(join(logsDir(), "lh-worker.log"));

function appendLog(level: "INFO" | "ERROR", message: string): void {
  if (fileDisabled) return;
  try {
    const now = new Date();
    const line = `[${now.toISOString()}] ${level} ${message}`;
    fileLog.append(line, now);
  } catch (error) {
    fileDisabled = true;
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      sanitizeWorkerLogMessage(
        `lh-worker: file logging disabled after write failure: ${reason}`,
      ),
    );
  }
}

export const workerLog = {
  info(message: string) {
    const sanitized = sanitizeWorkerLogMessage(message);
    console.log(sanitized);
    appendLog("INFO", sanitized);
  },
  error(message: string) {
    const sanitized = sanitizeWorkerLogMessage(message);
    console.error(sanitized);
    appendLog("ERROR", sanitized);
  },
};

export const workerLogFilePath = (now = new Date()) => fileLog.path(now);
