import { flags, sub } from "../args.ts";
import { fail, out, resolveRepo, run as runOp, svc } from "../context.ts";
import { usage } from "../usage.ts";

const SUBSCRIBE_USAGE =
  "usage: lh events subscribe --target herdr-pane --session <name> --pane <id> --resource <kind>:<key> [--resource <kind>:<key>]... [--repo owner/name] [--json]";
const UNSUBSCRIBE_USAGE =
  "usage: lh events unsubscribe --subscription <id> [--json]";

async function subscribe(): Promise<void> {
  const s = await svc();
  const repo = await resolveRepo();
  const { target, session, pane } = flags;
  const resources = flags.resource ?? [];
  if (!target) fail(`--target is required\n${SUBSCRIBE_USAGE}`);
  if (!session) fail(`--session is required\n${SUBSCRIBE_USAGE}`);
  if (!pane) fail(`--pane is required\n${SUBSCRIBE_USAGE}`);
  if (!resources.length) fail(`--resource is required\n${SUBSCRIBE_USAGE}`);
  const subscription = await runOp(() =>
    s.events.subscribe({ repo, target, session, pane, resources }),
  );
  if (flags.json) out(subscription);
  else
    console.log(
      `subscription #${subscription.id} (${subscription.target}) watching ` +
        subscription.resources
          .map((r) => `${r.resource_kind}:${r.resource_key}`)
          .join(", "),
    );
}

async function unsubscribe(): Promise<void> {
  const s = await svc();
  const id = Number(flags.subscription);
  if (!flags.subscription || !Number.isInteger(id) || id <= 0)
    fail(`--subscription must be a subscription id\n${UNSUBSCRIBE_USAGE}`);
  const released = await runOp(() =>
    s.events.unsubscribe({ subscription: id }),
  );
  if (flags.json) out(released);
  else console.log(`released subscription #${released.id}`);
}

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
  if (sub === "subscribe") return subscribe();
  if (sub === "unsubscribe") return unsubscribe();
  if (sub !== undefined) return usage();
  const s = await svc();
  const labels = (flags.label || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const types = (flags.type || "")
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
    types,
    runId: flags.run ? Number(flags.run) : undefined,
    order: flags.order === "desc" ? "desc" : "asc",
    limit: flags.limit ? Number(flags.limit) : undefined,
  });
  if (flags.json) out(evs);
  else evs.forEach(printEvent);
}
