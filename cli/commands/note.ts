import { flags, rest, sub } from "../args.ts";
import {
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
  if (sub === "add") {
    if (!flags.path) fail("--path is required");
    if (!flags.body) fail("--body is required");
    if (!flags.pr && (!flags.base || !flags.commit))
      fail("--base and --commit are required (or pass --pr to default them)");
    const n = await runOp(async () =>
      s.reviewNotes.create(
        repo,
        {
          path: flags.path as string,
          body: flags.body as string,
          ...(flags.base ? { baseSha: flags.base } : {}),
          ...(flags.commit ? { commitSha: flags.commit } : {}),
          ...(flags.pr ? { pr: Number(flags.pr) } : {}),
        },
        await writeSession(),
      ),
    );
    out(n);
    if (!flags.json)
      console.log(
        `note #${n.id} added on ${n.path} (${n.base_sha}..${n.commit_sha})`,
      );
  } else if (sub === "list") {
    const notes = await runOp(() =>
      s.reviewNotes.list(repo, {
        ...(flags.pr ? { pr: Number(flags.pr) } : {}),
        ...(flags.path ? { path: flags.path } : {}),
        ...(flags.base ? { baseSha: flags.base } : {}),
        ...(flags.commit ? { commitSha: flags.commit } : {}),
      }),
    );
    out(notes);
    if (!flags.json)
      notes.forEach((n: any) => {
        console.log(
          `#${n.id}\t${n.path}\t${n.base_sha}..${n.commit_sha}\t${n.body}`,
        );
      });
  } else if (sub === "get") {
    const n = await runOp(() => s.reviewNotes.get(repo, Number(rest[0])));
    out(n);
    if (!flags.json)
      console.log(
        `#${n.id}\t${n.path}\t${n.base_sha}..${n.commit_sha}\t${n.body}`,
      );
  } else if (sub === "edit") {
    if (!flags.body) fail("--body is required");
    const n = await runOp(async () =>
      s.reviewNotes.update(
        repo,
        Number(rest[0]),
        flags.body as string,
        await writeSession(),
      ),
    );
    out(n);
    if (!flags.json) console.log(`note #${n.id} updated`);
  } else if (sub === "rm") {
    await runOp(async () =>
      s.reviewNotes.remove(repo, Number(rest[0]), await writeSession()),
    );
    console.log(`note #${rest[0]} deleted`);
  } else usage();
}
