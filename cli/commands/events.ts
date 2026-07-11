import { flags } from "../args.ts";
import { out, svc } from "../context.ts";

export async function run(): Promise<void> {
  const removedFlag = process.argv
    .slice(2)
    .find((arg) => arg === "--follow" || arg === "-f");
  if (removedFlag) {
    console.error(
      `lh events: ${removedFlag} was removed; use a bounded snapshot such as ` +
        "lh events --since <id> --order asc",
    );
    process.exitCode = 2;
    return;
  }
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
  const evs = s.events.list({
    since: Number(flags.since || 0),
    repo: flags.repo || null,
    labels,
    order: flags.order === "desc" ? "desc" : "asc",
  });
  if (flags.json) out(evs);
  else evs.forEach(printEvent);
}
