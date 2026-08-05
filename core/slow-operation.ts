export type SlowOperationLogger = (message: string) => void;

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
