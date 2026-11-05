import { ServiceError } from "./errors.ts";
import { readProcessStream, spawnProcess } from "./process.ts";

// #2571: thin client over the herdr-core CLI (`hc`). Every call spawns `hc` with stdout piped and
// parses stdout as JSON. Piped output is JSON by default, except `hc run` and `hc read`, which
// print text unless the caller passes `--json`. A failure surfaces as a ServiceError that
// keeps hc's own `{error: {kind, message, hint}}`; there is no retry — a missing `hc` or an
// unreachable core is the operator's to fix.

export type HerdrCoreEnv = Record<string, string | undefined>;

// hc's error kinds a LoopHub caller can meet, mapped to the HTTP-style status the RPC layer
// reports. Unknown kinds stay visible as 500 with the kind preserved in `data`.
const KIND_STATUS: Record<string, number> = {
  not_found: 404,
  usage: 422,
  unavailable: 503,
  blocked: 409,
  finished: 409,
};

// The env a spawned `hc` sees. HC_TERMINAL_ID marks "started from that terminal": when LoopHub
// itself runs inside an hc terminal, passing it on would make every terminal LoopHub starts a
// child of LoopHub's own terminal (ending with it). Drop it so launches stay top-level.
export function herdrCoreEnv(env: HerdrCoreEnv = process.env): HerdrCoreEnv {
  const { HC_TERMINAL_ID: _dropped, ...rest } = env;
  return rest;
}

function spawnHerdrCore(
  args: string[],
  env: HerdrCoreEnv | undefined,
  stdin: "ignore" | Buffer,
): ReturnType<typeof spawnProcess> {
  try {
    return spawnProcess(["hc", ...args], {
      env: herdrCoreEnv(env),
      stdio: [stdin, "pipe", "pipe"],
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw code === "ENOENT"
      ? new ServiceError(422, "hc command not found on PATH", {
          kind: "not_installed",
          hint: "install herdr-core, or switch the repo's terminal backend to herdr",
        })
      : new ServiceError(500, `failed to launch hc (${code ?? "spawn error"})`);
  }
}

export async function runHerdrCore(
  args: string[],
  opts: { env?: HerdrCoreEnv } = {},
): Promise<unknown> {
  const child = spawnHerdrCore(args, opts.env, "ignore");
  const [stdout, stderr, status] = await Promise.all([
    readProcessStream(child.stdout),
    readProcessStream(child.stderr),
    child.exited,
  ]);
  if (status === 0) {
    try {
      return JSON.parse(stdout.text);
    } catch {
      throw new ServiceError(500, `hc ${args[0] ?? ""} printed invalid JSON`);
    }
  }
  throw herdrCoreError(stderr.text, status);
}

function herdrCoreError(stderr: string, status: number | null): ServiceError {
  let parsed: { error?: { kind?: unknown; message?: unknown; hint?: unknown } };
  try {
    parsed = JSON.parse(stderr);
  } catch {
    const output = stderr.trim();
    return new ServiceError(
      500,
      `hc exited with status ${status}${output ? `: ${output}` : ""}`,
    );
  }
  return herdrCoreServiceError(
    parsed.error?.kind,
    parsed.error?.message,
    parsed.error?.hint,
    `hc exited with status ${status}`,
  );
}

function herdrCoreServiceError(
  rawKind: unknown,
  rawMessage: unknown,
  rawHint: unknown,
  fallbackMessage: string,
): ServiceError {
  const kind = typeof rawKind === "string" ? rawKind : "unknown";
  const message = typeof rawMessage === "string" ? rawMessage : fallbackMessage;
  const hint = typeof rawHint === "string" ? rawHint : undefined;
  return new ServiceError(KIND_STATUS[kind] ?? 500, `herdr-core: ${message}`, {
    kind,
    hint,
  });
}

export interface HerdrCoreEventFollow {
  stop: () => void;
  // Settles when the stream ends. It ends cleanly when the core stops or restarts, and rejects when
  // `hc` fails or `onMessage` throws.
  done: Promise<void>;
}

// Follows `hc events --json`: the first line is the snapshot of matching terminals, then one
// JSON-RPC notification per line. Every parsed line goes to `onMessage`.
export function followHerdrCoreEvents(
  labels: Record<string, string>,
  onMessage: (message: unknown) => void,
  opts: { env?: HerdrCoreEnv } = {},
): HerdrCoreEventFollow {
  const child = spawnHerdrCore(
    [
      "events",
      "--json",
      ...Object.entries(labels).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]),
    ],
    opts.env,
    "ignore",
  );
  let stopped = false;
  const stop = () => {
    stopped = true;
    child.kill();
  };
  const readLines = async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") onMessage(JSON.parse(line));
      }
    }
  };
  const done = (async () => {
    const stderr = readProcessStream(child.stderr);
    try {
      await readLines();
    } catch (error) {
      child.kill();
      throw error;
    }
    const [status, errorOutput] = await Promise.all([child.exited, stderr]);
    if (status !== 0 && !stopped)
      throw herdrCoreError(errorOutput.text, status);
  })();
  return { stop, done };
}

const HERDR_CORE_RPC_TIMEOUT_MS = 30_000;

// One JSON-RPC call over `hc connect`. Launches need this rather than `hc run`: only the API takes
// `env`, the CLI gives a new terminal the core's environment and nothing of its own.
export async function callHerdrCore(
  method: string,
  params: Record<string, unknown>,
  opts: { env?: HerdrCoreEnv; timeoutMs?: number } = {},
): Promise<unknown> {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`;
  const child = spawnHerdrCore(["connect"], opts.env, Buffer.from(request));
  const timer = setTimeout(
    () => child.kill("SIGKILL"),
    opts.timeoutMs ?? HERDR_CORE_RPC_TIMEOUT_MS,
  );
  const [stdout, stderr, status] = await Promise.all([
    readProcessStream(child.stdout),
    readProcessStream(child.stderr),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  if (child.signalCode != null)
    throw new ServiceError(500, `hc ${method} did not finish in time`);
  if (status !== 0) throw herdrCoreError(stderr.text, status);
  let response: {
    result?: unknown;
    error?: {
      message?: unknown;
      data?: { kind?: unknown; hint?: unknown };
    };
  };
  try {
    response = JSON.parse(stdout.text);
  } catch {
    throw new ServiceError(500, `hc ${method} printed invalid JSON`);
  }
  if (response.error) {
    throw herdrCoreServiceError(
      response.error.data?.kind,
      response.error.message,
      response.error.data?.hint,
      `hc ${method} failed`,
    );
  }
  return response.result;
}
