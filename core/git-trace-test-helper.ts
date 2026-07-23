import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitTraceResult<T> {
  result: T;
  commands: string[];
  elapsedMs: number;
}

export async function traceGitCommands<T>(
  run: () => Promise<T>,
): Promise<GitTraceResult<T>> {
  const traceDir = mkdtempSync(join(tmpdir(), "lh-git-trace-"));
  const tracePath = join(traceDir, "events.json");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  const started = performance.now();
  try {
    const result = await run();
    const elapsedMs = performance.now() - started;
    const commands = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "start")
      .map((event) => event.argv.slice(3).join(" "));
    return { result, commands, elapsedMs };
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    rmSync(traceDir, { recursive: true, force: true });
  }
}
