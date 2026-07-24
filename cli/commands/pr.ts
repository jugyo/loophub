import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { CritLaunchPlan } from "../../core/service/pulls.ts";
import { flags, rest, sub } from "../args.ts";
import {
  fail,
  out,
  prStatusLabel,
  readStdin,
  resolveRepo,
  run as runOp,
  svc,
  writeSession,
} from "../context.ts";
import { buildCritReview, parseCritComments } from "../crit-comments.ts";
import { usage } from "../usage.ts";

// After crit's "Finish Review", fold its unresolved comments into a single FEEDBACK review via the
// existing `reviews.create` path (#1654, #1674). FEEDBACK is non-blocking (gate-neutral) yet still
// routes to a running run's Execute as out-of-band feedback to address. Zero unresolved comments →
// nothing is submitted. To submit an explicit merge-blocking review instead, use
// `lh pr review --event REQUEST_CHANGES`.
async function ingestCritReview(
  s: Awaited<ReturnType<typeof svc>>,
  repo: string,
  plan: CritLaunchPlan,
): Promise<void> {
  const res = spawnSync("crit", ["comments", "--json"], {
    cwd: plan.worktreePath,
    encoding: "utf8",
  });
  // A non-zero exit means crit could not read the review (e.g. no review file) — nothing to ingest.
  if (res.status !== 0) return;
  const review = buildCritReview(parseCritComments(res.stdout));
  if (!review) {
    console.error("crit: no unresolved comments; no review submitted");
    return;
  }
  await runOp(async () =>
    s.reviews.create(
      repo,
      plan.number,
      {
        event: "FEEDBACK",
        topic: "workflow",
        body: review.body,
        comments: review.comments,
      },
      await writeSession(),
    ),
  );
  console.error(
    `crit: submitted FEEDBACK review (${review.comments.length} line comment(s))`,
  );
}

export async function run(): Promise<void> {
  const s = await svc();
  const repo = await resolveRepo();
  if (sub === "list") {
    const items = await runOp(() =>
      s.pulls.list(repo, { state: flags.state || "open" }),
    );
    out(items);
    if (!flags.json)
      items.forEach((p: any) => {
        const status = prStatusLabel(p);
        console.log(
          `#${p.number}\t${status}\t${p.head.ref}->${p.base.ref}\t${p.title}`,
        );
      });
  } else if (sub === "view") {
    const p = await runOp(() => s.pulls.get(repo, Number(rest[0])));
    out(p);
    if (!flags.json) {
      const status = prStatusLabel(p);
      let line = `#${p.number} ${p.title} [${status}]\n${p.head.ref} -> ${p.base.ref}  mergeable=${p.mergeable_state}`;
      if (p.linked_issue)
        line += `\nlinked issue #${p.linked_issue.number} (${p.linked_issue.state})`;
      console.log(`${line}\n\n${p.body}`);
    }
  } else if (sub === "diff") {
    const files = await runOp(() => s.pulls.files(repo, Number(rest[0])));
    if (flags.json) out(files);
    else
      files.forEach((f: any) => {
        console.log(
          `--- ${f.filename} (+${f.additions} -${f.deletions})\n${f.patch}`,
        );
      });
  } else if (sub === "create") {
    const p = await runOp(async () =>
      s.pulls.create(
        repo,
        {
          title: flags.title ?? "",
          body: flags.body || "",
          head: flags.head ?? "",
          ...(flags.base ? { base: flags.base } : {}),
          ...(flags.issue ? { issue: Number(flags.issue) } : {}),
        },
        await writeSession(),
      ),
    );
    out(p);
    if (!flags.json) console.log(`created PR #${p.number}`);
  } else if (sub === "update") {
    const patch: { title?: string; body?: string } = {};
    if (flags.title !== undefined) patch.title = flags.title;
    if (flags.body !== undefined) patch.body = flags.body;
    if (Object.keys(patch).length === 0)
      fail("--title and/or --body is required");
    const p = await runOp(async () =>
      s.pulls.update(repo, Number(rest[0]), patch, await writeSession()),
    );
    out(p);
    if (!flags.json) console.log(`updated PR #${p.number}`);
  } else if (sub === "comment") {
    // Write commands return the resource they created/updated so an agent can verify from the
    // output what actually happened, instead of trusting a fixed success word (#1863).
    const number = Number(rest[0]);
    const c = await runOp(async () =>
      s.comments.createForPull(
        repo,
        number,
        flags.body ?? "",
        await writeSession(),
      ),
    );
    out(c);
    if (!flags.json)
      console.log(
        `commented on PR #${number} (comment ${c.id} by @${c.user.login})`,
      );
  } else if (sub === "merge") {
    const r = await runOp(async () =>
      s.pulls.merge(
        repo,
        Number(rest[0]),
        (flags.method || "squash") as any,
        await writeSession(),
      ),
    );
    out(r);
    if (!flags.json) console.log(`merged: ${r.sha}`);
  } else if (sub === "record-github-pr") {
    // #406: record the GitHub PR this loophub PR was exported to (used by the create-PR skill).
    // Also the general-purpose way to attach a GitHub PR created outside LoopHub back onto its
    // LoopHub PR (#487) — e.g. `lh pr record-github-pr <id> --url <github-pr-url>`. --number is
    // optional: if omitted, it is derived from the URL's `/pull/<number>` segment.
    if (!flags.url) fail("--url is required (the GitHub PR URL)");
    const g = await runOp(async () =>
      s.pulls.recordGithubPull(
        repo,
        Number(rest[0]),
        {
          ...(flags.number ? { github_number: Number(flags.number) } : {}),
          url: flags.url as string,
          ...(flags.branch ? { branch: flags.branch as string } : {}),
        },
        await writeSession(),
      ),
    );
    out(g);
    if (!flags.json) console.log(`recorded GitHub PR #${g.number} — ${g.url}`);
  } else if (sub === "create-github-pr") {
    // #411: one command for the create-github-pr skill — push the branch, open a GitHub Draft PR,
    // and record it back. The skill supplies the generated branch/title/body; `--body -` reads the
    // (template-derived) description from stdin to avoid shell-escaping a multi-line HEREDOC.
    if (!flags.branch)
      fail("--branch is required (the content-based GitHub branch name)");
    if (!flags.title) fail("--title is required (the GitHub PR title)");
    if (flags.body === undefined)
      fail("--body is required (- for stdin, or a file path)");
    // Same convention as `--comments`: `-` reads stdin, anything else is a file path. The skill
    // pipes the generated description via `--body -` and a HEREDOC.
    const body =
      flags.body === "-" ? await readStdin() : readFileSync(flags.body, "utf8");
    const g = await runOp(async () =>
      s.pulls.createGithubPull(
        repo,
        Number(rest[0]),
        {
          branch: flags.branch as string,
          title: flags.title as string,
          body,
        },
        await writeSession(),
      ),
    );
    out(g);
    if (!flags.json) console.log(`created GitHub PR #${g.number} — ${g.url}`);
  } else if (sub === "push-github-pr") {
    // #848: push the current head to the branch of the already-recorded GitHub PR, so local commits
    // added after the export reach GitHub without re-creating the PR. Requires an existing github_pull.
    const g = await runOp(async () =>
      s.pulls.pushGithubPull(repo, Number(rest[0]), {}, await writeSession()),
    );
    out(g);
    if (!flags.json)
      console.log(`pushed to GitHub PR #${g.number} branch ${g.branch}`);
  } else if (sub === "review") {
    let comments: any;
    if (flags.comments) {
      const raw =
        flags.comments === "-"
          ? await readStdin()
          : readFileSync(flags.comments, "utf8");
      comments = JSON.parse(raw); // [{ path, line, side?, body }, ...]
    }
    const res = await runOp(async () =>
      s.reviews.create(
        repo,
        Number(rest[0]),
        {
          event: (flags.event || "comment").toUpperCase(),
          body: flags.body || "",
          ...(flags.topic ? { topic: flags.topic } : {}),
          ...(flags.model ? { model: flags.model } : {}),
          // Pin the review to an explicit commit (defaults to the PR's current head). A Workflow
          // Verify child passes the head SHA it was launched against (#1358).
          ...(flags.commit ? { headSha: flags.commit } : {}),
          comments,
        },
        await writeSession(),
      ),
    );
    out(res);
    if (!flags.json)
      console.log(
        `review ${res.id} submitted: ${res.state} (${res.comments} line comment(s))`,
      );
  } else if (sub === "ready-for-review") {
    const p = await runOp(async () =>
      s.pulls.readyForReview(
        repo,
        Number(rest[0]),
        flags.body || "",
        await writeSession(),
      ),
    );
    out(p);
    if (!flags.json)
      console.log(
        `PR #${p.number} marked ready for review (${p.review_state})`,
      );
  } else if (sub === "crit") {
    // Launch the external `crit` browser UI against this PR's attempt worktree.
    // Resolution (worktree path + range base) lives in core; the CLI only spawns with stdio
    // inherited. crit is optional — missing binary is a clear error, not an auto-install.
    if (rest[0] == null || rest[0] === "")
      fail("usage: lh pr crit <pr> [--repo owner/name]");
    const plan = await runOp(() => s.pulls.critLaunch(repo, Number(rest[0])));
    console.error(`crit PR #${plan.number}`);
    console.error(`  worktree: ${plan.worktreePath}`);
    console.error(`  range:    ${plan.range}`);
    const proc = spawnSync("crit", ["--range", plan.range], {
      stdio: "inherit",
      cwd: plan.worktreePath,
    });
    if (proc.error) {
      const err = proc.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        fail(
          "crit not found on PATH. Install it first (this command does not install crit):\n" +
            "  brew install crit\n" +
            "  # or: go install github.com/tomasz-tomczyk/crit@latest\n" +
            "  # see https://crit.md for other install options",
        );
      }
      fail(`failed to launch crit: ${err.message}`);
    }
    // crit blocks until the human clicks "Finish Review"; a clean exit is that submit signal.
    // A pane kill (no exit status) or a non-zero exit is not a submission — do not ingest.
    if (proc.status === 0) {
      await ingestCritReview(s, repo, plan);
    }
    process.exit(proc.status ?? 1);
  } else if (sub === "close" || sub === "reopen") {
    const number = Number(rest[0]);
    const state = sub === "close" ? "closed" : "open";
    const before = await runOp(() => s.pulls.get(repo, number));
    const p = await runOp(async () =>
      s.pulls.update(repo, number, { state }, await writeSession()),
    );
    out(p);
    if (!flags.json)
      console.log(
        before.state === state
          ? `PR #${p.number} was already ${state} (no change)`
          : `${sub === "close" ? "closed" : "reopened"} PR #${p.number} (${before.state} -> ${p.state})`,
      );
  } else usage();
}
