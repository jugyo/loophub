import { flags, sub } from "../args.ts";
import { confirm, out, run as runOp, svc } from "../context.ts";
import { withLoading } from "../loading.ts";
import { usage } from "../usage.ts";

export async function run(): Promise<void> {
  if (sub !== "prune") {
    usage();
    return;
  }
  const s = await svc();
  const dryRun = flags["dry-run"] === true;
  const assumeYes = flags.yes === true;
  const force = flags.force === true;
  const repoFilter = flags.repo ?? null;

  // Scanning, issue/PR resolution and classification live in core (s.worktrees); the CLI only
  // presents, confirms, and reports.
  const entries = await runOp(() =>
    withLoading(
      "Scanning worktrees...",
      () => s.worktrees.plan({ repo: repoFilter, cwd: process.cwd(), force }),
      { enabled: !flags.json && process.stderr.isTTY === true },
    ),
  );
  const candidates = entries.filter((e) => e.action === "remove");
  const keep = entries.filter((e) => e.action === "keep");
  const skip = entries.filter((e) => e.action === "skip");

  if (flags.json) {
    out({ candidates, keep, skip, dryRun });
  } else {
    const fmt = (e: (typeof entries)[number]) =>
      `  ${e.repo}#${e.issue}\t${e.path}\t(${e.reason})`;
    console.log(`Remove candidates (${candidates.length}):`);
    for (const e of candidates) console.log(fmt(e));
    if (keep.length) {
      console.log(`\nKeep (${keep.length}):`);
      for (const e of keep) console.log(fmt(e));
    }
    if (skip.length) {
      console.log(`\nSkip (${skip.length}):`);
      for (const e of skip) console.log(fmt(e));
    }
  }

  if (dryRun) {
    if (!flags.json) console.log("\ndry-run: nothing removed.");
    return;
  }

  if (candidates.length === 0) {
    if (!flags.json) console.log("\nNothing to prune.");
    await s.worktrees.tidy(repoFilter); // still tidy stale admin entries
    return;
  }

  if (!assumeYes) {
    const ok = await confirm(`\nRemove ${candidates.length} worktree(s)?`);
    if (!ok) {
      if (!flags.json) console.log("aborted.");
      return;
    }
  }

  let removed = 0;
  for (const e of candidates) {
    const res = await s.worktrees.remove({ ...e, force });
    if (res.removed) {
      removed++;
      if (!flags.json) console.log(`removed ${e.path}`);
    } else {
      console.error(`failed to remove ${e.path}: ${res.reason}`);
    }
  }

  await s.worktrees.tidy(repoFilter);
  if (!flags.json) console.log(`\nPruned ${removed} worktree(s).`);
}
