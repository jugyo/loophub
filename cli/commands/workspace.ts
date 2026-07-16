import { flags, rest, sub } from "../args.ts";
import {
  display,
  fail,
  out,
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
    const branch = rest[0];
    if (!branch)
      fail("usage: lh workspace create <branch> [--repo owner/name]");
    const workspace = await runOp(async () =>
      s.workspaces.create(repo, { branch }, await writeSession()),
    );
    console.log(`created ${display(workspace.branch)}`);
  } else if (sub === "list") {
    const workspaces = await runOp(() => s.workspaces.list(repo));
    out(workspaces);
    if (!flags.json) {
      for (const workspace of workspaces) {
        console.log(
          `${display(workspace.branch)}\tbranch_exists=${workspace.branch_exists}`,
        );
      }
    }
  } else if (sub === "archive") {
    const branch = rest[0];
    if (!branch)
      fail("usage: lh workspace archive <branch> [--repo owner/name]");
    const workspace = await runOp(async () =>
      s.workspaces.archive(repo, branch, await writeSession()),
    );
    console.log(`archived ${display(workspace.branch)}`);
  } else usage();
}
