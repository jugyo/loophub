import { readFileSync } from "node:fs";
import { flags, rest, sub } from "../args.ts";
import {
  fail,
  out,
  readStdin,
  relativeTime,
  resolveRepo,
  run as runOp,
  svc,
  writeSession,
} from "../context.ts";
import { usage } from "../usage.ts";

export async function run(): Promise<void> {
  const s = await svc();
  const repo = await resolveRepo();
  if (sub === "create") {
    const usageLine =
      "usage: lh retro create --pr <m> --input <file|-> [--status draft]";
    if (!flags.pr) fail(usageLine);
    if (!flags.input) fail(`--input is required\n${usageLine}`);
    const raw =
      flags.input === "-"
        ? await readStdin()
        : readFileSync(flags.input, "utf8");
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      fail("--input must be JSON: { rubric: [...], findings: [...], status? }");
    }
    const retro = await runOp(async () =>
      s.retros.create(
        repo,
        {
          pr: Number(flags.pr),
          rubric: data.rubric,
          findings: data.findings,
          status: flags.status ?? data.status,
          redacted: data.redacted,
          redact_ruleset: data.redact_ruleset,
        },
        await writeSession(),
      ),
    );
    if (flags.json) out(retro);
    else
      console.log(
        `created retro #${retro.id} for PR #${retro.pr?.number} (${retro.status})`,
      );
  } else if (sub === "list") {
    const rows = await runOp(() =>
      s.retros.list(repo, {
        pr: flags.pr ? Number(flags.pr) : undefined,
        status: flags.status,
      }),
    );
    out(rows);
    if (!flags.json)
      rows.forEach((rt: any) => {
        const warn = rt.rubric.filter((x: any) => x.severity === "warn").length;
        const bad = rt.rubric.filter((x: any) => x.severity === "bad").length;
        console.log(
          `#${rt.id}\tPR #${rt.pr?.number ?? "?"}\t${rt.status}\twarn:${warn} bad:${bad}\tfindings:${rt.findings.length}\t${relativeTime(rt.created_at)}`,
        );
      });
  } else if (sub === "view") {
    if (!rest[0]) fail("usage: lh retro view <id>");
    const rt = await runOp(() => s.retros.get(repo, Number(rest[0])));
    out(rt);
    if (!flags.json) {
      const lines: string[] = [];
      lines.push(
        `retro #${rt.id} [${rt.status}]  PR #${rt.pr?.number ?? "?"}${rt.pr ? ` ${rt.pr.title}` : ""}`,
      );
      if (rt.issue) lines.push(`linked issue #${rt.issue.number}`);
      lines.push(`session: ${rt.session_id ?? "(none)"}`);
      lines.push("");
      lines.push("Rubric:");
      for (const x of rt.rubric)
        lines.push(
          `  [${x.severity}] ${x.id} ${x.signal}=${x.value ?? ""}${x.note ? ` — ${x.note}` : ""}`,
        );
      lines.push("");
      lines.push("Findings:");
      for (const f of rt.findings)
        lines.push(
          `  [${f.severity}] (${f.category}) ${f.note}${f.evidence_ref ? ` <${f.evidence_ref}>` : ""}${f.proposed_action ? `\n    -> ${f.proposed_action}` : ""}`,
        );
      console.log(lines.join("\n"));
    }
  } else if (sub === "pending") {
    const items = await runOp(() =>
      s.retros.pending(repo, {
        limit: flags.limit ? Number(flags.limit) : undefined,
      }),
    );
    out(items);
    if (!flags.json)
      items.forEach((p: any) => {
        console.log(
          `#${p.number}\t${p.title}\tmerged ${p.merged_at ? relativeTime(p.merged_at) : "?"}`,
        );
      });
  } else usage();
}
