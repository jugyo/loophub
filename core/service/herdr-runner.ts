import { ServiceError, spawn } from "./shared.ts";

// The expected `herdr tab create` output is one small JSON object; anything past this cap is
// discarded so a misbehaving herdr streaming output can't grow lh-web memory unbounded.
const HERDR_CAPTURE_MAX_BYTES = 64 * 1024;

// Spawns Herdr asynchronously (never spawnSync — this runs inside the lh-web server process,
// which also serves SSE/RPC for every other client). Errors are deliberately generic: the
// underlying stderr/stdout (or an OS error message) can embed the repo's absolute local_path,
// so it is never forwarded to the client. Resolves with the drained stdout when captureStdout
// is set, "" otherwise.
export function runHerdr(
  command: string,
  args: string[],
  cwd: string,
  opts: { captureStdout?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdio defaults to all "ignore": the client never sees stdout/stderr (see the comment
    // above), and a "pipe" nobody drains would let the child's writes fill the OS pipe buffer
    // and block forever (no `close` event, an indefinitely hanging RPC call) — or crash the
    // whole lh-web process on an unhandled stream error. captureStdout pipes stdout but always
    // drains it (and handles its `error` event below, so a stream error can't crash lh-web).
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "ignore"],
    });
    // Settle-once guard: the success path settles on `close` (all output drained), but the
    // timeout path settles immediately — `close` waits for the stdout pipe to shut, and a
    // descendant process that inherited the pipe fd can hold it open past herdr's own death,
    // which would leave the promise pending forever (and wedge terminal.sessions' coalescing
    // slot until a server restart).
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Guards the awaiting RPC call against a herdr client that never exits (e.g. wedged on its
    // session socket): kill and reject right away (see the settle-once comment above).
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          settle(() =>
            reject(
              new ServiceError(
                500,
                `Herdr timed out after ${opts.timeoutMs}ms`,
              ),
            ),
          );
        }, opts.timeoutMs)
      : undefined;
    const chunks: Buffer[] = [];
    let captured = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (captured >= HERDR_CAPTURE_MAX_BYTES) return; // keep draining, stop keeping
      chunks.push(chunk);
      captured += chunk.length;
    });
    child.stdout?.on("error", () => {
      // Losing the output stream only means the tab id can't be read; the `close` handler
      // still decides success/failure, so just stop the error from being unhandled.
    });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      settle(() =>
        reject(
          code === "ENOENT"
            ? new ServiceError(422, "herdr command not found on PATH")
            : new ServiceError(
                500,
                `failed to launch Herdr (${code ?? "spawn error"})`,
              ),
        ),
      );
    });
    child.on("close", (status, signal) => {
      // `status` is null when the child was terminated by a signal rather than exiting on its
      // own — treat that as a failure too, instead of `?? 0` collapsing a null code to success.
      // The distinction (signal vs. exit code) is itself a safe, non-leaky hint about *why* the
      // launch failed, so surface it instead of one generic "Herdr launch failed" for both.
      settle(() => {
        if (signal == null && status === 0)
          resolve(Buffer.concat(chunks).toString("utf8"));
        else if (signal != null)
          reject(
            new ServiceError(
              500,
              `Herdr process was terminated by signal ${signal}`,
            ),
          );
        else
          reject(new ServiceError(500, `Herdr exited with status ${status}`));
      });
    });
  });
}

export function runHerdrLaunch(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return runHerdr(command, args, cwd).then(() => {});
}

export function runHerdrLaunchCapture(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return runHerdr(command, args, cwd, { captureStdout: true });
}

// Herdr query command for the sidebar status sweep (#495): capture stdout with a hard
// timeout. Rides on runHerdr so the spawn/capture-cap/error semantics stay in one place;
// callers treat any rejection as "no data". The cwd is irrelevant to `herdr session list` /
// `agent list`, so the server's own cwd will do.
export function runHerdrCapture(args: string[]): Promise<string> {
  return runHerdr("herdr", args, process.cwd(), {
    captureStdout: true,
    timeoutMs: 10_000,
  });
}
