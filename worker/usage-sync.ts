import { execFile } from "node:child_process";
import { selfCliCommand } from "../core/self-exec.ts";
import type { SessionUsageSyncResult } from "../core/service/sessions.ts";

// Transcript discovery and parsing use synchronous filesystem APIs. Run the existing thin CLI
// procedure in a separate process so a large transcript set cannot starve lh-worker's heartbeat or
// its other timers. The subprocess shares LOOPHUB_HOME/LOOPHUB_DB; a non-zero exit remains a
// visible sweep failure and is retried only by the next interval.
export function runUsageSyncSubprocess(): Promise<SessionUsageSyncResult> {
  const cli = selfCliCommand();
  return new Promise((resolve, reject) => {
    execFile(
      cli.command,
      [...cli.args, "session", "usage", "sync", "--json"],
      {
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
