import { flags, sub } from "../args.ts";
import {
  fail,
  out,
  readStdin,
  resolveRepo,
  run as runOp,
  svc,
} from "../context.ts";
import { usage } from "../usage.ts";

function parseObjectFlag(name: "from" | "to", value: string | undefined) {
  if (value == null) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed;
  } catch {}
  fail(`--${name} must be a JSON object`);
}

export async function run(): Promise<void> {
  const s = await svc();
  const repo = await resolveRepo();
  if (sub === "send") {
    const sendUsage =
      "usage: lh inbox send --from '<json>' --title <text> --body <text|-> [--to '<json>'] [--label <name>] [--repo owner/name] [--json]";
    if (!flags.from) fail(`--from is required\n${sendUsage}`);
    if (!flags.title) fail(`--title is required\n${sendUsage}`);
    if (!flags.body) fail(`--body is required\n${sendUsage}`);
    const body = flags.body === "-" ? await readStdin() : flags.body;
    const message = await runOp(() =>
      s.inbox.send(repo, {
        from: parseObjectFlag("from", flags.from),
        to: parseObjectFlag("to", flags.to),
        label: flags.label,
        title: flags.title,
        body,
      }),
    );
    if (flags.json) out(message);
    else console.log(`sent inbox message #${message.id}`);
  } else usage();
}
