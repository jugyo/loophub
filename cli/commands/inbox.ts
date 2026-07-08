import { flags, rest, sub } from "../args.ts";
import {
  fail,
  out,
  readStdin,
  resolveRepo,
  run as runOp,
  svc,
  writeSession,
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

function parseMessageId(): number {
  const raw = rest[0] ?? flags.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0)
    fail("message id must be a positive integer");
  return id;
}

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "send") {
    const repo = await resolveRepo();
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
  } else if (
    sub === "read" ||
    sub === "unread" ||
    sub === "archive" ||
    sub === "unarchive" ||
    sub === "delete"
  ) {
    const id = parseMessageId();
    const sessionId = await writeSession();
    const message = await runOp(() => {
      if (sub === "read") return s.inbox.read(id, sessionId);
      if (sub === "unread") return s.inbox.unread(id, sessionId);
      if (sub === "archive") return s.inbox.archive(id, sessionId);
      if (sub === "unarchive") return s.inbox.unarchive(id, sessionId);
      return s.inbox.delete(id, sessionId);
    });
    if (flags.json) out(message);
    else console.log(`inbox message #${message.id} is ${message.state}`);
  } else usage();
}
