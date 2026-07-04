import type { EventDebugEntry } from "@/lib/event-debug";
import { EVENT_DEBUG_LIMIT, useEventDebugEntries } from "@/lib/event-debug";

const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|authorization|cookie|session|credential|api[_-]?key|access[_-]?key|private[_-]?key|apiKey|accessKey|privateKey/i;

export function EventDebugPage() {
  const entries = useEventDebugEntries();

  return (
    <div className="mx-auto max-w-content">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Event debug</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Recent SSE events received by this UI session.
          </p>
        </div>
        <div className="rounded-md border px-3 py-1.5 text-sm tabular-nums">
          {entries.length} / {EVENT_DEBUG_LIMIT}
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No events received yet.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Received</th>
                <th className="px-3 py-2 font-medium">Event ID</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Repo</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Payload</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <EventDebugRow key={entry.sequence} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EventDebugRow({ entry }: { entry: EventDebugEntry }) {
  const isLoopHub = entry.source === "loophub";
  const event = isLoopHub ? entry.event : null;
  const isInvalid = entry.source === "invalid-loophub";

  return (
    <tr className="border-b align-top last:border-b-0">
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
        {formatTime(entry.received_at)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
        {event?.id ?? (isInvalid ? "invalid" : "none")}
      </td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
        {event?.type ?? (isInvalid ? "invalid loophub" : "terminal")}
      </td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
        {event?.repo ?? (isInvalid ? "unknown" : "all")}
      </td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
        {event
          ? formatTime(event.created_at)
          : isInvalid
            ? "unreadable"
            : "non-persistent"}
      </td>
      <td className="max-w-[36rem] px-3 py-2">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {payloadText(entry)}
        </pre>
      </td>
    </tr>
  );
}

function payloadText(entry: EventDebugEntry): string {
  if (entry.source === "loophub") {
    return JSON.stringify(redactSensitive(entry.event.payload), null, 2);
  }
  if (entry.source === "invalid-loophub") {
    return JSON.stringify(
      { reason: entry.reason, raw: redactSensitiveText(entry.raw) },
      null,
      2,
    );
  }
  return "{}";
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitive(nested),
    ]),
  );
}

export function redactSensitiveText(value: string): string {
  try {
    return JSON.stringify(redactSensitive(JSON.parse(value)));
  } catch {
    // Fall through to conservative text redaction for malformed frames.
  }

  return value
    .replace(
      /(["']?)([A-Za-z0-9_-]*(?:token|secret|password|passwd|authorization|cookie|session|credential|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(["'])(.*?)\4/gi,
      (_match, quote, key, separator, valueQuote) =>
        `${quote}${key}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`,
    )
    .replace(
      /(["']?)([A-Za-z0-9_-]*(?:token|secret|password|passwd|authorization|cookie|session|credential|api[_-]?key|access[_-]?key|private[_-]?key|apiKey|accessKey|privateKey)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)([^\n,}]+)/gi,
      (_match, quote, key, separator) =>
        `${quote}${key}${quote}${separator}${REDACTED}`,
    );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
