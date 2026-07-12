import { flags, sub } from "../args.ts";
import {
  fail,
  out,
  resolveRepo,
  run as runOp,
  SESSION_ID,
  svc,
} from "../context.ts";
import { usage } from "../usage.ts";

// `lh subscribe` / `lh unsubscribe` (#1232): register the calling herdr pane as a subscriber for
// repo events. The pane identity comes from the HERDR_SESSION / HERDR_PANE_ID env vars herdr sets
// in every pane, so an agent session can subscribe itself without knowing anything about herdr
// internals; the flags exist for tests and for subscribing another pane deliberately.

function paneIdentity(): { herdrSession: string; herdrPaneId: string } {
  const herdrSession = flags["herdr-session"] || process.env.HERDR_SESSION;
  const herdrPaneId = flags["herdr-pane-id"] || process.env.HERDR_PANE_ID;
  if (!herdrSession || !herdrPaneId) {
    fail(
      "Not inside a herdr pane (HERDR_SESSION / HERDR_PANE_ID are unset); " +
        "pass --herdr-session and --herdr-pane-id to subscribe a pane explicitly.",
    );
  }
  return { herdrSession, herdrPaneId };
}

function eventTypes(usageLine: string): string[] {
  const types = (flags.event || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (types.length === 0) fail(`--event is required\n${usageLine}`);
  return types;
}

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "list") {
    const rows = await runOp(() =>
      s.subscriptions.list({ repo: flags.repo || null }),
    );
    if (flags.json) out(rows);
    else
      for (const r of rows)
        console.log(
          `${r.id}\t${r.repo}\t${r.event_type}\t${r.herdr_session}/${r.herdr_pane_id}`,
        );
    return;
  }
  if (sub !== undefined) return usage();
  const subscribeUsage =
    "usage: lh subscribe --event <type>[,<type>...] [--repo owner/name] [--json]";
  const types = eventTypes(subscribeUsage);
  const repo = await resolveRepo();
  const identity = paneIdentity();
  const results = [];
  for (const eventType of types) {
    results.push(
      await runOp(() =>
        s.subscriptions.add({
          repo,
          eventType,
          ...identity,
          sessionId: SESSION_ID ?? null,
        }),
      ),
    );
  }
  // Keep `created` in the JSON shape: a scripted caller needs to tell a fresh registration from
  // an idempotent re-run, which the human-readable lines already distinguish.
  if (flags.json)
    out(results.map((r) => ({ ...r.subscription, created: r.created })));
  else
    for (const r of results)
      console.log(
        `${r.created ? "subscribed" : "already subscribed"}: ${r.subscription.event_type} in ${r.subscription.repo} -> ${r.subscription.herdr_session}/${r.subscription.herdr_pane_id}`,
      );
}

export async function runUnsubscribe(): Promise<void> {
  // Same unknown-positional guard as run(): `lh unsubscribe list --all` must show usage, not
  // silently remove every subscription.
  if (sub !== undefined) return usage();
  const s = await svc();
  const unsubscribeUsage =
    "usage: lh unsubscribe --event <type>[,<type>...] | --all  [--repo owner/name]";
  // --all and --event are exclusive alternatives; silently letting --all win would take the
  // broader destructive interpretation, so reject the combination visibly.
  if (flags.all && flags.event) fail(unsubscribeUsage);
  // No --repo means every repo: a pane may hold the same event type in several repos, so the
  // repo filter is what lets it drop just one of them.
  const identity = { ...paneIdentity(), repo: flags.repo || null };
  let removed = 0;
  if (flags.all) {
    removed = (await runOp(() => s.subscriptions.removeForPane(identity)))
      .removed;
  } else {
    for (const eventType of eventTypes(unsubscribeUsage)) {
      removed += (
        await runOp(() =>
          s.subscriptions.removeForPane({ ...identity, eventType }),
        )
      ).removed;
    }
  }
  console.log(`removed ${removed} subscription(s)`);
}
