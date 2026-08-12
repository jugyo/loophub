import { flags, sub } from "../args.ts";
import {
  fail,
  out,
  resolveRepo,
  run as runOp,
  svc,
  writeSession,
} from "../context.ts";
import { readTextInput } from "../text-input.ts";
import { usage } from "../usage.ts";

function parseResource(raw: string | undefined): {
  resourceKind: "issue" | "pull" | "repo";
  resourceNumber?: number;
} {
  if (!raw || raw === "repo") return { resourceKind: "repo" };
  const match = /^(issue|pull):([1-9]\d*)$/.exec(raw);
  if (!match) {
    fail("--resource must be repo, issue:<number>, or pull:<number>");
  }
  const kind = match[1] as "issue" | "pull";
  const number = Number(match[2]);
  return { resourceKind: kind, resourceNumber: number };
}

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "send") {
    const repo = await resolveRepo();
    const sendUsage =
      "usage: lh notification send --kind merge_ready|over_budget|human_attention|agent_comment --title <text> --body <text|-> [--resource repo|issue:<n>|pull:<n>] [--herdr-pane-id <id>] [--source-key <key>] [--repo owner/name] [--json]";
    if (!flags.kind) fail(`--kind is required\n${sendUsage}`);
    if (!flags.title) fail(`--title is required\n${sendUsage}`);
    if (flags.body === undefined) fail(`--body is required\n${sendUsage}`);
    const body = await readTextInput(flags.body);
    const resource = parseResource(flags.resource);
    const notification = await runOp(async () =>
      s.notifications.send(
        repo,
        {
          kind: flags.kind,
          title: flags.title,
          body,
          ...resource,
          sourceKey: flags["source-key"],
          herdrPaneId: flags["herdr-pane-id"],
        },
        await writeSession(),
      ),
    );
    if (flags.json) out(notification);
    else console.log(`sent notification #${notification.id}`);
  } else usage();
}
