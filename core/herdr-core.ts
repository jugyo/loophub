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
};

// The env a spawned `hc` sees. HC_TERMINAL_ID marks "started from that terminal": when LoopHub
// itself runs inside an hc terminal, passing it on would make every terminal LoopHub starts a
// child of LoopHub's own terminal (ending with it). Drop it so launches stay top-level.
export function herdrCoreEnv(env: HerdrCoreEnv = process.env): HerdrCoreEnv {
  const { HC_TERMINAL_ID: _dropped, ...rest } = env;
  return rest;
}

export async function runHerdrCore(
  args: string[],
  opts: { env?: HerdrCoreEnv } = {},
): Promise<unknown> {
  let child: ReturnType<typeof spawnProcess>;
  try {
    child = spawnProcess(["hc", ...args], {
      env: herdrCoreEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
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
  const kind =
    typeof parsed.error?.kind === "string" ? parsed.error.kind : "unknown";
  const message =
    typeof parsed.error?.message === "string"
      ? parsed.error.message
      : `hc exited with status ${status}`;
  const hint =
    typeof parsed.error?.hint === "string" ? parsed.error.hint : undefined;
  return new ServiceError(KIND_STATUS[kind] ?? 500, `herdr-core: ${message}`, {
    kind,
    hint,
  });
}
