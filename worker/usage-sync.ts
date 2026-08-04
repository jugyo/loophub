import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SessionUsageSyncResult } from "../core/service/sessions.ts";

const cliEntry = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// Transcript discovery and parsing use synchronous filesystem APIs. Run the existing thin CLI
// procedure in a separate process so a large transcript set cannot starve lh-worker's heartbeat or
// its other timers. The subprocess shares LOOPHUB_HOME/LOOPHUB_DB and carries the required SQLite
// flags; a non-zero exit remains a visible sweep failure and is retried only by the next interval.
export function runUsageSyncSubprocess(): Promise<SessionUsageSyncResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--experimental-sqlite",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        cliEntry,
        "session",
        "usage",
        "sync",
        "--json",
      ],
      {
        cwd: projectRoot,
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`usage sync subprocess failed: ${error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as SessionUsageSyncResult);
        } catch {
          reject(new Error("usage sync subprocess returned invalid JSON"));
        }
      },
    );
  });
}
