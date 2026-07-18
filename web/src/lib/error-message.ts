// Extract a human-readable string from a caught value for display. ApiError extends Error, so
// prefer `error.message` (e.g. the bare 422 validation text) over `String(error)`, which would
// prepend the class name ("ApiError: <message>"). This matches the codebase's dominant
// error-display pattern (issue-list, pull-list, ...).
//
// With `prefix`, format a mutation failure as `"<prefix>: <message>"` when the error carries a
// message, else `"<prefix>."`.
export function errorMessage(error: unknown, prefix?: string): string {
  if (prefix !== undefined) {
    return error instanceof Error
      ? `${prefix}: ${error.message}`
      : `${prefix}.`;
  }
  return error instanceof Error ? error.message : String(error);
}
