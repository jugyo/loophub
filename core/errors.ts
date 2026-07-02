// Transport-neutral error carrying an HTTP-style status. Both the CLI (S5) and the
// future JSON-RPC layer (S2) translate `status` into their own error shape, so service
// procedures stay independent of any transport.
// Extra fields a ServiceError may carry alongside `message` to the client. Deliberately an
// allowlisted shape, not Record<string, unknown> — widening it would let a future throw site
// silently start forwarding arbitrary (possibly sensitive: raw stdout/stderr, absolute paths,
// stack traces) data to every JSON-RPC caller with no additional transport-layer signal.
export interface ServiceErrorData {
  command?: string;
  // The Herdr session name a launch failure relates to — lets the client suggest creating that
  // session first, since `agent start` only works over the socket of an already-running session.
  session?: string;
}

export class ServiceError extends Error {
  status: number;
  data?: ServiceErrorData;
  constructor(status: number, message: string, data?: ServiceErrorData) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.data = data;
  }
}

export function isServiceError(e: unknown): e is ServiceError {
  return e instanceof ServiceError;
}
