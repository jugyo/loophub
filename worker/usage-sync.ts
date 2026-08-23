import { readProcessStream, spawnProcess } from "../core/process.ts";
import { selfCliCommand } from "../core/self-exec.ts";
import type { SessionUsageSyncResult } from "../core/service/sessions.ts";

// Transcript discovery and parsing use synchronous filesystem APIs. Run the existing thin CLI
// procedure in a separate process so a large transcript set cannot starve lh-worker's heartbeat or
// its other timers. The subprocess shares LOOPHUB_HOME/LOOPHUB_DB; a non-zero exit remains a
// visible sweep failure and is retried only by the next interval.
export function runUsageSyncSubprocess(): Promise<SessionUsageSyncResult> {
  const cli = selfCliCommand();
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(
        [cli.command, ...cli.args, "session", "usage", "sync", "--json"],
        {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 16 * 1024 * 1024,
        },
      );
    } catch (error) {
      reject(
        new Error(
          `usage sync subprocess failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
      return;
    }
    let maxBufferExceeded = false;
    const stopAtMaxBuffer = () => {
      if (maxBufferExceeded) return;
      maxBufferExceeded = true;
      child.kill("SIGTERM");
    };
    Promise.all([
      readProcessStream(child.stdout, 16 * 1024 * 1024, stopAtMaxBuffer),
      readProcessStream(child.stderr, 16 * 1024 * 1024, stopAtMaxBuffer),
      child.exited,
    ])
      .then(([stdout, stderr, exitCode]) => {
        if (
          stdout.exceededMaxBuffer ||
          stderr.exceededMaxBuffer ||
          exitCode !== 0
        ) {
          reject(
            new Error(
              stdout.exceededMaxBuffer || stderr.exceededMaxBuffer
                ? "usage sync subprocess exceeded max buffer"
                : `usage sync subprocess failed with status ${exitCode}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout.text) as SessionUsageSyncResult);
        } catch {
          reject(new Error("usage sync subprocess returned invalid JSON"));
        }
      })
      .catch((error) =>
        reject(
          new Error(
            `usage sync subprocess failed: ${error instanceof Error ? error.message : error}`,
          ),
        ),
      );
  });
}
