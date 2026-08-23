import { ServiceError } from "../errors.ts";
import { spawnProcess } from "../process.ts";

// Pane listings grow with the session's retained workspaces and can legitimately exceed 64 KiB.
// Keep captures bounded, but leave enough room for the complete JSON instead of silently handing
// parsers a truncated document that makes every agent in a busy repo disappear.
const HERDR_CAPTURE_MAX_BYTES = 1024 * 1024;
const HERDR_SERVER_READY_MAX_BYTES = 64 * 1024;
const HERDR_SERVER_READY = "herdr server running;";

export class HerdrExitError extends ServiceError {
  readonly exitStatus: number;
  // Herdr's own stderr, captured only when the caller asked for it (captureStderr). Herdr reports
  // its failures there as a JSON `error.code`, which is what a failed launch step is diagnosed
  // from. It can embed the repo's absolute local_path, so it stays server-side: never put it in a
  // message a client sees.
  readonly stderr: string;

  constructor(exitStatus: number, stderr = "") {
    super(500, `Herdr exited with status ${exitStatus}`);
    this.exitStatus = exitStatus;
    this.stderr = stderr;
  }
}

export function isHerdrExitError(error: unknown): error is HerdrExitError {
  return error instanceof HerdrExitError;
}

export function herdrExitErrorCode(error: unknown): string | null {
  if (!isHerdrExitError(error) || !error.stderr) return null;
  try {
    const parsed = JSON.parse(error.stderr) as {
      error?: { code?: unknown };
    };
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

async function consumeStream(
  stream: ReadableStream<Uint8Array<any>> | null | undefined,
  onChunk: (chunk: Uint8Array<any>) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      onChunk(result.value);
    }
  } catch {
    // 出力 pipe の切断はプロセスの終了結果で判定する。
  } finally {
    reader.releaseLock();
  }
}

// Spawns Herdr asynchronously (never spawnSync — this runs inside the lh-web server process,
// which also serves RPC for every other client). Errors are deliberately generic: the
// underlying stderr/stdout (or an OS error message) can embed the repo's absolute local_path,
// so it is never forwarded to the client. Resolves with the drained stdout when captureStdout
// is set, "" otherwise.
export function runHerdr(
  command: string,
  args: string[],
  cwd: string,
  opts: {
    captureStdout?: boolean;
    captureStderr?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdio defaults to all "ignore": the client never sees stdout/stderr (see the comment
    // above), and a "pipe" nobody drains would let the child's writes fill the OS pipe buffer
    // and block forever (no `close` event, an indefinitely hanging RPC call) — or crash the
    // whole lh-web process on an unhandled stream error. captureStdout pipes stdout but always
    // drains it (and handles its `error` event below, so a stream error can't crash lh-web).
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess([command, ...args], {
        cwd,
        stdio: [
          "ignore",
          opts.captureStdout ? "pipe" : "ignore",
          opts.captureStderr ? "pipe" : "ignore",
        ],
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        code === "ENOENT"
          ? new ServiceError(422, "herdr command not found on PATH")
          : new ServiceError(
              500,
              `failed to launch Herdr (${code ?? "spawn error"})`,
            ),
      );
      return;
    }
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
    const stdoutDone = consumeStream(child.stdout, (chunk) => {
      if (captured >= HERDR_CAPTURE_MAX_BYTES) return;
      const room = HERDR_CAPTURE_MAX_BYTES - captured;
      const piece = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      chunks.push(Buffer.from(piece));
      captured += piece.byteLength;
    });
    let stderr = "";
    let capturedStderr = 0;
    const stderrDone = consumeStream(child.stderr, (chunk) => {
      if (capturedStderr >= HERDR_CAPTURE_MAX_BYTES) return;
      const room = HERDR_CAPTURE_MAX_BYTES - capturedStderr;
      const piece = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      stderr += Buffer.from(piece).toString("utf8");
      capturedStderr += piece.byteLength;
    });
    child.exited
      .then(async (status) => {
        await Promise.all([stdoutDone, stderrDone]);
        const signal = child.signalCode;
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
          else if (status !== null) reject(new HerdrExitError(status, stderr));
          else reject(new ServiceError(500, "Herdr exited without a status"));
        });
      })
      .catch((error) =>
        settle(() =>
          reject(
            new ServiceError(
              500,
              `failed to launch Herdr (${error instanceof Error ? error.message : error})`,
            ),
          ),
        ),
      );
  });
}

// Starts a named Herdr session as a detached headless server and resolves once Herdr announces
// that its API socket is ready. Unlike runHerdr, success does not wait for the resident server to
// exit. This lets the caller create the first workspace immediately without holding an RPC open
// for the lifetime of the session.
export function startHerdrSession(
  sessionName: string,
  cwd: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(["herdr", "--session", sessionName, "server"], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        code === "ENOENT"
          ? new ServiceError(422, "herdr command not found on PATH")
          : new ServiceError(
              500,
              `failed to launch Herdr (${code ?? "spawn error"})`,
            ),
      );
      return;
    }
    let settled = false;
    let output = "";
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() =>
        reject(new ServiceError(500, `Herdr timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    const consumeOutput = (chunk: Uint8Array<any>) => {
      output = `${output}${Buffer.from(chunk).toString("utf8")}`.slice(
        -HERDR_SERVER_READY_MAX_BYTES,
      );
      if (!output.includes(HERDR_SERVER_READY)) return;
      settle(() => {
        // 常駐プロセスの pipe はバックグラウンドで drain し続ける。
        (child.stdout as { unref?: () => void } | undefined)?.unref?.();
        (child.stderr as { unref?: () => void } | undefined)?.unref?.();
        child.unref();
        resolve();
      });
    };
    void consumeStream(child.stdout, consumeOutput);
    void consumeStream(child.stderr, consumeOutput);
    child.exited
      .then((status) => {
        settle(() => {
          const signal = child.signalCode;
          if (signal != null)
            reject(
              new ServiceError(
                500,
                `Herdr process was terminated by signal ${signal}`,
              ),
            );
          else if (status !== 0) reject(new HerdrExitError(status ?? 1));
          else
            reject(
              new ServiceError(
                500,
                "Herdr exited before its server became ready",
              ),
            );
        });
      })
      .catch((error) =>
        settle(() =>
          reject(
            new ServiceError(
              500,
              `failed to launch Herdr (${error instanceof Error ? error.message : error})`,
            ),
          ),
        ),
      );
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
