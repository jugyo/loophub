export type SlowOperationLogger = (message: string) => void;

export const SLOW_GIT_OPERATION_MS = 100;

let logger: SlowOperationLogger | undefined;

/** Enable diagnostics for this process, or disable them when omitted. */
export function configureSlowOperationLogging(
  nextLogger?: SlowOperationLogger,
): void {
  logger = nextLogger;
}

/**
 * Emit one diagnostic line, or do nothing while diagnostics are disabled.
 *
 * The message is built lazily so a disabled process pays nothing for a line it would not print.
 * Every diagnostic shares this switch so that one flag turns them all on.
 */
export function logDiagnostic(message: () => string): void {
  logger?.(message());
}

export function diagnosticLoggingEnabled(): boolean {
  return logger !== undefined;
}

export async function measureDiagnostic<T>(
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!logger) return operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    const durationMs = Math.round(performance.now() - started);
    logDiagnostic(() => `pageData phase=${phase} duration_ms=${durationMs}`);
  }
}
