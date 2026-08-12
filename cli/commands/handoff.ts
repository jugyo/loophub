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

export async function run(): Promise<void> {
  // Record / list orchestrator<->subagent handoffs (#352). A handoff binds to a PR (--pr, the
  // ref the design's `--ref <pr>` names) and/or a generic issue (--issue); the recording session
  // is the attribution session (--session-id), so the record hangs off "PR + session" naturally.
  const s = await svc();
  const repo = await resolveRepo();
  if (sub === "record") {
    const recordUsage =
      "usage: lh handoff record --phase <p> --dir <down|up> (--pr <n> | --issue <n>) (--body <text|-> | --src <ref> [--hash <sha>]) [--from <r>] [--to <r>] [--summary <text>] [--model <m>] [--cost <json>] [--repo owner/name]";
    if (!flags.phase || !flags.dir) fail(recordUsage);
    if (!flags.pr && !flags.issue)
      fail(`--pr or --issue is required\n${recordUsage}`);
    if (flags.body === undefined && !flags.src)
      fail(`--body or --src is required\n${recordUsage}`);
    // `--body -` reads the instruction/report from stdin so large prompts aren't shell args.
    const body =
      flags.body === undefined ? undefined : await readTextInput(flags.body);
    const session = await writeSession();
    const h = await runOp(() =>
      s.handoffs.record(
        repo,
        {
          phase: flags.phase as string,
          direction: flags.dir as string,
          pr: flags.pr ? Number(flags.pr) : undefined,
          issue: flags.issue ? Number(flags.issue) : undefined,
          from: flags.from,
          to: flags.to,
          body,
          src: flags.src,
          hash: flags.hash,
          summary: flags.summary,
          model: flags.model,
          cost: flags.cost,
        },
        session,
      ),
    );
    if (flags.json) out(h);
    else {
      const target = h.pull_request
        ? `PR #${h.pull_request.number}`
        : `issue #${h.issue?.number}`;
      console.log(
        `recorded handoff #${h.seq} (${h.phase}/${h.direction}) on ${target}${h.summary ? `: ${h.summary}` : ""}`,
      );
    }
  } else if (sub === "list") {
    const handoffs = await runOp(() =>
      s.handoffs.list(repo, {
        ...(flags.pr ? { pr: Number(flags.pr) } : {}),
        ...(flags.issue ? { issue: Number(flags.issue) } : {}),
        ...(flags.session ? { session: flags.session } : {}),
      }),
    );
    if (flags.json) out(handoffs);
    else
      handoffs.forEach((h: any) => {
        const ref = h.src ? `src=${h.src}` : "body";
        console.log(
          `#${h.seq}\t${h.phase}/${h.direction}\t${h.from ?? "?"}→${h.to ?? "?"}\t${ref}\t${h.summary ?? ""}`,
        );
      });
  } else usage();
}
