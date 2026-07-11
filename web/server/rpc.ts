// JSON-RPC 2.0 dispatcher. Transport-neutral: it takes a parsed JSON-RPC payload (a single
// request or a batch array) and returns the response value(s). The HTTP binding (POST /rpc)
// lives in the lh-web process (S3). Method routing, params validation (ajv against the
// contract schemas), and error mapping happen here.
import Ajv, { type ValidateFunction } from "ajv";
import { isServiceError } from "../../core/errors.ts";
import { methods } from "./contract.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();
for (const [name, def] of Object.entries(methods)) {
  validators.set(name, ajv.compile(def.params));
}

// JSON-RPC reserved codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
// Application errors (ServiceError) — server-defined range. The HTTP-style status is in data.
const APP_ERROR = -32000;
const RESPONSE_TOO_LARGE = -32001;
const REQUEST_TOO_LARGE = -32002;

export const MAX_RPC_BATCH_SIZE = 100;

type Id = string | number | null;

export interface RpcSuccess {
  jsonrpc: "2.0";
  id: Id;
  result: unknown;
}
export interface RpcFailure {
  jsonrpc: "2.0";
  id: Id;
  error: { code: number; message: string; data?: unknown };
}
export type RpcResponse = RpcSuccess | RpcFailure;

function ok(id: Id, result: unknown): RpcSuccess {
  return { jsonrpc: "2.0", id, result };
}
function fail(
  id: Id,
  code: number,
  message: string,
  data?: unknown,
): RpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function responseTooLarge(id: Id): RpcFailure {
  return fail(id, RESPONSE_TOO_LARGE, "Response too large");
}

export function requestTooLarge(maxBytes: number): RpcFailure {
  return fail(null, REQUEST_TOO_LARGE, "Request body too large", {
    status: 413,
    maxBytes,
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Returns a response, or null for a valid notification (request without `id`).
async function dispatchOne(req: unknown): Promise<RpcResponse | null> {
  if (
    !isPlainObject(req) ||
    req.jsonrpc !== "2.0" ||
    typeof req.method !== "string"
  ) {
    return fail(null, INVALID_REQUEST, "Invalid Request");
  }
  const isNotification = !("id" in req);
  const id = (req.id ?? null) as Id;

  const def = methods[req.method];
  if (!def)
    return isNotification
      ? null
      : fail(id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);

  const params = req.params ?? {};
  if (!isPlainObject(params)) {
    return isNotification
      ? null
      : fail(id, INVALID_PARAMS, "params must be an object");
  }

  const validate = validators.get(req.method)!;
  if (!validate(params)) {
    const data = (validate.errors ?? []).map((e) => ({
      path: e.instancePath || "/",
      message: e.message ?? "invalid",
    }));
    return isNotification
      ? null
      : fail(id, INVALID_PARAMS, "Invalid params", data);
  }

  try {
    const result = await def.handler(params);
    return isNotification ? null : ok(id, result ?? null);
  } catch (e: any) {
    if (isNotification) return null;
    if (isServiceError(e))
      return fail(id, APP_ERROR, e.message, { status: e.status, ...e.data });
    return fail(id, INTERNAL_ERROR, "Internal error", { message: e?.message });
  }
}

// Dispatch a parsed JSON-RPC payload. Single -> one response (or null for a notification);
// batch array -> array of responses (notifications omitted); empty batch -> Invalid Request.
export async function dispatch(
  payload: unknown,
): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0)
      return fail(null, INVALID_REQUEST, "Invalid Request");
    if (payload.length > MAX_RPC_BATCH_SIZE)
      return fail(
        null,
        INVALID_REQUEST,
        `Batch too large (max ${MAX_RPC_BATCH_SIZE} requests)`,
      );
    const responses = await Promise.all(payload.map(dispatchOne));
    return responses.filter((r): r is RpcResponse => r !== null);
  }
  return dispatchOne(payload);
}

// Parse a raw JSON string then dispatch. Use this at the HTTP boundary (S3) so a parse
// error becomes a proper JSON-RPC error rather than a thrown exception.
export async function dispatchRaw(
  raw: string,
): Promise<RpcResponse | RpcResponse[] | null> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail(null, PARSE_ERROR, "Parse error");
  }
  return dispatch(payload);
}

export const ERROR_CODES = {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  APP_ERROR,
  RESPONSE_TOO_LARGE,
  REQUEST_TOO_LARGE,
} as const;
