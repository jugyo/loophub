// Table renderer for the PR debug dump (#248). Turns the raw aggregate object from `pulls/debug`
// into a scannable, collapsible view: each top-level key is a section, objects render as key/value
// tables, and arrays of objects (events, commits, files, reviews…) render as columnar tables. It is
// a generic recursive renderer over JSON values, so it stays correct as the dump's shape evolves.
// For copy/paste and exact-value inspection the modal's Copy JSON button copies the full dump.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// One JSON value, rendered by type. Objects → key/value table; arrays of objects → columnar table;
// multi-line strings → scrollable <pre>; everything else → inline mono text.
function DebugValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="font-mono">{String(value)}</span>;
  }
  if (typeof value === "string") {
    if (value === "") {
      return <span className="text-muted-foreground italic">(empty)</span>;
    }
    if (value.includes("\n")) {
      return (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-xs leading-relaxed">
          {value}
        </pre>
      );
    }
    return <span className="font-mono break-all">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">empty</span>;
    }
    if (value.every(isPlainObject)) {
      return <ObjectArrayTable rows={value as Record<string, unknown>[]} />;
    }
    return (
      <ol className="flex list-inside list-decimal flex-col gap-1">
        {value.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional list of opaque JSON values.
          <li key={i}>
            <DebugValue value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (isPlainObject(value)) {
    return <KeyValueTable obj={value} />;
  }
  return <span className="font-mono break-all">{String(value)}</span>;
}

function KeyValueTable({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">empty</span>;
  }
  return (
    <table className="w-full border-collapse text-xs">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k} className="border-b align-top last:border-0">
            <td className="w-48 max-w-48 py-1 pr-3 align-top font-mono font-medium text-muted-foreground">
              {k}
            </td>
            <td className="py-1 align-top">
              <DebugValue value={v} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Array of objects as a single table: columns are the union of all rows' keys (first-seen order),
// so heterogeneous rows still line up and missing fields show as "—".
function ObjectArrayTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!cols.includes(k)) cols.push(k);
    }
  }
  // No shared keys (e.g. rows are all empty objects) → a columnar table would be blank and hide
  // the item count, so fall back to a numbered list that still renders each row.
  if (cols.length === 0) {
    return (
      <ol className="flex list-inside list-decimal flex-col gap-1">
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows of opaque JSON values.
          <li key={i}>
            <DebugValue value={row} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b text-left">
            {cols.map((c) => (
              <th
                key={c}
                className="whitespace-nowrap py-1 pr-3 font-mono font-medium text-muted-foreground"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows of opaque JSON values.
            <tr key={i} className="border-b align-top last:border-0">
              {cols.map((c) => (
                <td key={c} className="py-1 pr-3 align-top">
                  {Object.hasOwn(row, c) ? (
                    <DebugValue value={row[c]} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The whole dump: one collapsible section per top-level key, arrays tagged with their length. */
export function DebugDataView({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex flex-col gap-3">
      {Object.entries(data).map(([key, value]) => (
        <details key={key} open className="overflow-hidden rounded-md border">
          <summary className="cursor-pointer list-none bg-muted/40 px-3 py-2 font-mono text-sm font-medium [&::-webkit-details-marker]:hidden">
            {key}
            {Array.isArray(value) ? (
              <span className="ml-1 text-muted-foreground">
                ({value.length})
              </span>
            ) : null}
          </summary>
          <div className="p-3">
            <DebugValue value={value} />
          </div>
        </details>
      ))}
    </div>
  );
}
