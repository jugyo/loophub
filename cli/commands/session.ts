import { sessionRuntime } from "../../core/session-runtime.ts";
import { flags, rest, sub } from "../args.ts";
import { fail, out, run as runOp, svc } from "../context.ts";
import { usage } from "../usage.ts";

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "usage") {
    const usageSub = rest[0];
    if (usageSub === "sync" || usageSub === "recalculate") {
      const result = s.sessions.usageSync({
        ...(flags.session ? { sessionId: flags.session } : {}),
        full: usageSub === "recalculate" || !!flags.full,
      });
      out(result);
      if (!flags.json) {
        console.log(
          `synced ${result.synced}, skipped ${result.skipped}, missing ${result.missing}`,
        );
        for (const row of result.sessions) {
          console.log(
            `${row.session_id}\t${row.status}\t${row.messages} message(s)`,
          );
        }
      }
    } else if (!usageSub || usageSub === "confirm") {
      const rows = s.sessions.usage(flags.session);
      out(rows);
      if (!flags.json) {
        for (const x of rows) {
          const cost = x.cost_usd == null ? "n/a" : `$${x.cost_usd.toFixed(6)}`;
          console.log(
            `${x.model}\tinput=${x.input_tokens}\tcache_write=${x.cache_creation_input_tokens}\tcache_read=${x.cache_read_input_tokens}\toutput=${x.output_tokens}\tcost=${cost}`,
          );
        }
      }
    } else usage();
  } else if (sub === "register") {
    const { id, agent, session } = flags;
    if (!id || !agent || !session)
      fail("--id, --agent, and --session are required");
    const { session: row } = await runOp(() =>
      s.sessions.register({
        id,
        agent,
        session,
        ...(flags.name ? { name: flags.name } : {}),
        ...(flags.runtime ? { runtime: flags.runtime } : {}),
        ...(flags.model ? { model: flags.model } : {}),
        ...(flags.kind ? { kind: flags.kind } : {}),
      }),
    );
    console.log(`registered session ${row.id} (${row.agent})`);
  } else if (sub === "list") {
    const rows = s.sessions.list();
    out(rows);
    if (!flags.json)
      rows.forEach((x: any) => {
        console.log(
          `${x.id}\t${x.agent}\truntime=${sessionRuntime(x) ?? "unknown"}\tmodel=${x.model ?? "default"}\tsession=${x.session}${x.name ? `\t${x.name}` : ""}`,
        );
      });
  } else usage();
}
