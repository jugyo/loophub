export type BunProcessOptions = Bun.SpawnOptions.BaseOptions<
  Bun.SpawnOptions.Writable,
  Bun.SpawnOptions.Readable,
  Bun.SpawnOptions.Readable
>;

export interface SyncProcessResult {
  stdout?: Buffer;
  stderr?: Buffer;
  exitCode: number | null;
  signalCode: string | null;
  exitedDueToTimeout?: boolean;
  exitedDueToMaxBuffer?: boolean;
  error?: unknown;
}

export type BunPipeSubprocess = Bun.Subprocess<
  Bun.SpawnOptions.Writable,
  "pipe",
  "pipe"
>;

type ProcessSpawner = (
  argv: string[],
  options: BunProcessOptions,
) => BunPipeSubprocess;

let processSpawner: ProcessSpawner = (argv, options) =>
  Bun.spawn(argv, { env: process.env, ...options }) as BunPipeSubprocess;

export function spawnSyncProcess(
  argv: string[],
  options: BunProcessOptions = {},
): SyncProcessResult {
  try {
    const result = Bun.spawnSync(argv, {
      env: process.env,
      ...options,
    } as Bun.SpawnOptions.SpawnSyncOptions<any, any, any>);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? null,
      signalCode: result.signalCode ?? null,
      exitedDueToTimeout: result.exitedDueToTimeout,
      exitedDueToMaxBuffer: result.exitedDueToMaxBuffer,
    };
  } catch (error) {
    return {
      exitCode: null,
      signalCode: null,
      error,
    };
  }
}

export function spawnProcess(
  argv: string[],
  options: BunProcessOptions = {},
): BunPipeSubprocess {
  return processSpawner(argv, { env: process.env, ...options });
}

export function setProcessSpawnerForTests(spawner: ProcessSpawner): () => void {
  const previous = processSpawner;
  processSpawner = spawner;
  return () => {
    processSpawner = previous;
  };
}

export interface ProcessStreamResult {
  text: string;
  exceededMaxBuffer: boolean;
}

export async function readProcessStream(
  stream: ReadableStream<Uint8Array<any>> | null | undefined,
  maxBytes = Number.POSITIVE_INFINITY,
  onMaxBuffer: () => void = () => {},
): Promise<ProcessStreamResult> {
  if (!stream) return { text: "", exceededMaxBuffer: false };
  const reader = stream.getReader();
  const chunks: Uint8Array<any>[] = [];
  let captured = 0;
  let exceededMaxBuffer = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (captured >= maxBytes) {
        if (result.value.byteLength > 0 && !exceededMaxBuffer) {
          exceededMaxBuffer = true;
          onMaxBuffer();
        }
        continue;
      }
      const room = maxBytes - captured;
      const chunk =
        result.value.byteLength > room
          ? result.value.subarray(0, room)
          : result.value;
      chunks.push(chunk);
      captured += chunk.byteLength;
      if (chunk.byteLength < result.value.byteLength && !exceededMaxBuffer) {
        exceededMaxBuffer = true;
        onMaxBuffer();
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8",
    ),
    exceededMaxBuffer,
  };
}
