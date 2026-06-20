// Transport-neutral error carrying an HTTP-style status. Both the CLI (S5) and the
// future JSON-RPC layer (S2) translate `status` into their own error shape, so service
// procedures stay independent of any transport.
export class ServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export function isServiceError(e: unknown): e is ServiceError {
  return e instanceof ServiceError;
}
