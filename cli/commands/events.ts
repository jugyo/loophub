import { flags } from "../args.ts";
import { out, svc } from "../context.ts";

export async function run(): Promise<void> {
  const s = await svc();
  const labels = (flags.label || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const printEvent = (e: {
    id: number;
    type: string;
    actor: string;
    payload: unknown;
  }) => {
    if (flags.json) console.log(JSON.stringify(e));
    else
      console.log(
        `${e.id}\t${e.type}\t${e.actor}\t${JSON.stringify(e.payload)}`,
      );
  };
  if (flags.follow) {
    // Stream the SSE feed continuously. Order is always chronological (a live tail can't
    // be reversed); --order applies only to the one-shot snapshot. --json emits one JSON
    // object per line (NDJSON) rather than the snapshot's single array.
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort()); // Ctrl-C: stop cleanly, exit 0
    try {
      await s.events.follow(
        { since: Number(flags.since || 0), repo: flags.repo || null, labels },
        printEvent,
        controller.signal,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }
  const evs = s.events.list({
    since: Number(flags.since || 0),
    repo: flags.repo || null,
    labels,
    order: flags.order === "desc" ? "desc" : "asc",
  });
  if (flags.json) out(evs);
  else evs.forEach(printEvent);
}
