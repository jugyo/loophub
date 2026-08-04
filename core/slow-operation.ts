export const SLOW_OPERATION_THRESHOLD_MS = 1000;

export type SlowOperationKind = "sql" | "git";
export type SlowOperationLogger = (message: string) => void;

let logger: SlowOperationLogger | undefined;

/** Enable slow-operation diagnostics for this process, or disable them when omitted. */
export function configureSlowOperationLogging(
  nextLogger?: SlowOperationLogger,
): void {
  logger = nextLogger;
}

/**
 * Emit one diagnostic line, or do nothing while diagnostics are disabled.
 *
 * The message is built lazily so a disabled process pays nothing for a line it would not print.
 * Diagnostics that are not about duration share this switch so that one flag turns them all on.
 */
export function logDiagnostic(message: () => string): void {
  logger?.(message());
}

function reportIfSlow(
  activeLogger: SlowOperationLogger,
  kind: SlowOperationKind,
  operation: () => string,
  startedAt: number,
): void {
  const durationMs = performance.now() - startedAt;
  if (durationMs <= SLOW_OPERATION_THRESHOLD_MS) return;
  activeLogger(
    `[slow-operation] kind=${kind} duration_ms=${durationMs.toFixed(1)} ${operation()}`,
  );
}

export function measureSlowOperation<T>(
  kind: SlowOperationKind,
  operation: () => string,
  run: () => T,
): T {
  const activeLogger = logger;
  if (!activeLogger) return run();

  const startedAt = performance.now();
  try {
    return run();
  } finally {
    reportIfSlow(activeLogger, kind, operation, startedAt);
  }
}

export async function measureSlowOperationAsync<T>(
  kind: SlowOperationKind,
  operation: () => string,
  run: () => Promise<T>,
): Promise<T> {
  const activeLogger = logger;
  if (!activeLogger) return run();

  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    reportIfSlow(activeLogger, kind, operation, startedAt);
  }
}
