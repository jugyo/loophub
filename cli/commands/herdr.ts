import { flags, rest, sub } from "../args.ts";
import {
  display,
  fail,
  out,
  resolveRepo,
  run as runOp,
  svc,
} from "../context.ts";
import { usage } from "../usage.ts";

export async function run(): Promise<void> {
  const s = await svc();
  const repo = await resolveRepo();
  if (sub === "focus") {
    const pull = Number(rest[0]);
    if (!rest[0] || !Number.isInteger(pull))
      fail("usage: lh herdr focus <pr> [--repo owner/name]");
    const result = await runOp(() => s.herdr.focus({ repo, pull }));
    out(result);
    if (!flags.json)
      console.log(`focused pane ${display(result.pane_id)} (PR #${pull})`);
    return;
  }
  if (sub !== undefined) {
    usage();
    return;
  }
  const tree = await runOp(() => s.herdr.tree({ repo }));
  out(tree);
  if (flags.json) return;
  if (!tree.running) {
    console.log(
      `herdr session "${tree.session_name}" is not running for ${repo}.`,
    );
    return;
  }
  console.log(`herdr session: ${tree.session_name}`);
  if (tree.workspaces.length === 0) console.log("  (no workspaces)");
  for (const w of tree.workspaces) {
    console.log(
      `workspace #${w.number} ${display(w.label)} (${display(w.id)})`,
    );
    if (w.tabs.length === 0) console.log("  (no tabs)");
    for (const t of w.tabs) {
      console.log(`  tab #${t.number} (${display(t.id)})`);
      if (t.agents.length === 0) console.log("    (no agents)");
      for (const a of t.agents) {
        const pr = a.pull !== null ? ` PR #${a.pull}` : "";
        console.log(
          `    - ${display(a.name)} [${display(a.status)}] pane=${display(a.id)}${pr}`,
        );
      }
    }
  }
}
