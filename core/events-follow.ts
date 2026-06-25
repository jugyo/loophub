// Client side of the events SSE feed: subscribe to the web server's `GET /events`
// (replay-then-subscribe) and hand each event to a caller as it arrives — the engine
// behind `lh events --follow`. The CLI imports core directly for snapshots (events.list),
// but a live tail needs the resident lh-web process, so this is the one events path that
// talks HTTP. Server-side replay/live + since/repo filtering lives in web/server/events.ts;
// `--label` has no SSE query param, so it is filtered here against the shared DB.
import { baseUrl } from "./config.ts";
import type { LoopEvent } from "./event-hub.ts";
import * as S from "./store.ts";

// Wire frame the server pushes (web/server/events.ts `eventNotification`). Defined locally
// to keep the core->web layering one-directional (core never imports web).
interface EventNotification {
  jsonrpc: "2.0";
  method: "events/notify";
  params: LoopEvent;
}

// Cap the inter-frame buffer so a peer that streams bytes without ever sending a frame
// terminator can't grow memory unbounded (defensive — the only producer is the trusted
// local lh-web). Frames are tiny notifications, so a few MB is far above any real frame.
const MAX_SSE_BUFFER = 4 * 1024 * 1024;

// Incremental SSE parser. Chunks may split a frame, so buffer until the `\n\n` terminator
// and emit one notification per `event: loophub` frame; heartbeats (`: ...` comments) and
// any other event types are ignored. Pure and stateful — unit-tested independently of fetch.
export function createSseParser(): (chunk: string) => EventNotification[] {
  let buf = "";
  return (chunk: string): EventNotification[] => {
    buf += chunk;
    const out: EventNotification[] = [];
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) {
        if (buf.length > MAX_SSE_BUFFER) {
          throw new Error(
            "SSE frame exceeded buffer limit without a terminator",
          );
        }
        break;
      }
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event: string | null = null;
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // comment / heartbeat
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (event !== "loophub" || data.length === 0) continue;
      try {
        const n = JSON.parse(data.join("\n")) as EventNotification;
        if (n?.method === "events/notify" && n.params) out.push(n);
      } catch {
        // Skip a malformed frame rather than tear down the stream.
      }
    }
    return out;
  };
}

// Mirror the snapshot's `--label` semantics (store.listEvents' EXISTS join) for a single live
// event: the event's repo must have an issue whose number matches `payload.number` and which
// carries at least one of the requested labels. Events without a repo/number never match.
export function eventMatchesLabels(
  event: LoopEvent,
  labels: string[],
): boolean {
  if (labels.length === 0) return true;
  if (!event.repo) return false;
  const number = (event.payload as { number?: unknown } | null)?.number;
  if (typeof number !== "number") return false;
  const [owner, name] = event.repo.split("/");
  const repo = S.getRepo(owner, name);
  if (!repo) return false;
  const issue = S.getIssue(repo.id, number);
  if (!issue) return false;
  const names = new Set(
    S.issueLabels(issue.id).map((l: { name: string }) => l.name),
  );
  return labels.some((l) => names.has(l));
}

export interface FollowOptions {
  since?: number;
  repo?: string | null;
  labels?: string[];
}

// Subscribe to the SSE feed and invoke `onEvent` for each matching event (replay first, then
// live), keeping the connection open until `signal` aborts (Ctrl-C). Throws a clear error if
// the web server is unreachable or replies with a non-OK status.
export async function followEvents(
  opts: FollowOptions,
  onEvent: (event: LoopEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL("/events", baseUrl());
  if (opts.since) url.searchParams.set("since", String(opts.since));
  if (opts.repo) url.searchParams.set("repo", opts.repo);
  const labels = opts.labels ?? [];

  // Move any basic-auth userinfo out of the URL into a header: Node fetch rejects a
  // credentialed URL outright (and echoes it in the error), so stripping it both lets the
  // request work and keeps credentials out of error text / logs.
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (url.username || url.password) {
    // Fall back to the raw component if it isn't valid percent-encoding, so malformed
    // credentials surface the clean "is lh-web running" error rather than a URIError.
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    const user = decode(url.username);
    const pass = decode(url.password);
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    url.username = "";
    url.password = "";
  }
  // Endpoint for error text: origin (now credential-free) + path.
  const safeUrl = `${url.origin}${url.pathname}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal });
  } catch (err) {
    if (signal?.aborted) return; // aborted before the connection opened
    throw new Error(
      `cannot reach the LoopHub server at ${safeUrl} — is lh-web running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`unexpected response from ${safeUrl}: HTTP ${res.status}`);
  }

  const parse = createSseParser();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const n of parse(decoder.decode(value, { stream: true }))) {
        const event = n.params;
        if (!eventMatchesLabels(event, labels)) continue;
        onEvent(event);
      }
    }
  } catch (err) {
    if (signal?.aborted) return; // clean Ctrl-C / abort
    throw err;
  } finally {
    // Release the lock / tear down the HTTP connection on every exit (done, abort, throw).
    // The CLI exits anyway, but a long-lived reuse (future JSON-RPC/web layer) must not leak.
    reader.cancel().catch(() => {});
  }
}
