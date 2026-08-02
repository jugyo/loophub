import { readFileSync } from "node:fs";
import type { DiffFeedbackThreadDetailWire } from "../../core/serialize.ts";
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
import { usage } from "../usage.ts";

// A `--comments` / `--ac-results` argument is inline JSON or a file path (#1895). stdin support was
// dropped so the two review channels never both need stdin at once: an argument that starts with a
// JSON opener is used verbatim, anything else is read as a file.
function readJsonArg(value: string): string {
  const trimmed = value.trimStart();
  return trimmed.startsWith("[") || trimmed.startsWith("{")
    ? value
    : readFileSync(value, "utf8");
}

// A diff feedback conversation as text: where it points, the diff around it, then the exchange.
// `>` marks the lines the anchor selected, so the anchored code stands out from its context.
function feedbackThreadText(thread: DiffFeedbackThreadDetailWire): string {
  const anchor = thread.resolved_anchor ?? thread.anchor;
  const context = (thread.context ?? [])
    .map((line) => `${line.anchored ? ">" : " "} ${line.text}`)
    .join("\n");
  return [
    `#${thread.id} ${thread.freshness}${
      thread.outdated_reason ? ` (${thread.outdated_reason})` : ""
    }`,
    `${anchor.path}:${anchor.start_line}-${anchor.end_line} ${anchor.side}`,
    ...(context ? ["", context] : []),
    "",
    thread.messages
      .map((message) => `@${message.author}: ${message.body}`)
      .join("\n"),
  ].join("\n");
}

export async function run(): Promise<void> {
  const s = await svc();
  const repo = await resolveRepo();
  if (sub === "feedback") {
    const [action, target] = rest;
    const number = Number(
      flags.pr ??
        (action === "create" || action === "list" || action === "pending"
          ? target
          : 0),
    );
    const radius =
      flags.context === undefined ? undefined : Number(flags.context);
    if (action === "list") {
      const result = await runOp(() => s.diffFeedback.list(repo, number));
      out(result);
      if (!flags.json)
        result.threads.forEach((thread) => {
          const anchor = thread.resolved_anchor ?? thread.anchor;
          console.log(
            `#${thread.id}\t${thread.freshness}\t${anchor.path}:${anchor.start_line}-${anchor.end_line}`,
          );
        });
    } else if (action === "view") {
      if (!flags.pr) fail("--pr is required");
      const thread = await runOp(() =>
        s.diffFeedback.get(repo, Number(flags.pr), Number(target), radius),
      );
      out(thread);
      if (!flags.json) console.log(feedbackThreadText(thread));
    } else if (action === "pending") {
      if (!flags.run) fail("--run is required");
      const result = await runOp(() =>
        s.diffFeedback.pending(repo, number, Number(flags.run), radius),
      );
      out(result);
      if (!flags.json)
        console.log(
          result.threads.length === 0
            ? `no unanswered feedback conversations for run #${result.run}`
            : result.threads.map(feedbackThreadText).join("\n\n"),
        );
    } else if (action === "create") {
      const result = await runOp(async () =>
        s.diffFeedback.create(
          repo,
          number,
          {
            baseSha: flags["base-sha"] ?? "",
            headSha: flags["head-sha"] ?? "",
            path: flags.path ?? "",
            side: flags.side?.toUpperCase() ?? "",
            startLine: Number(flags["start-line"]),
            endLine: Number(flags["end-line"]),
            body: flags.body ?? "",
          },
          await writeSession(),
        ),
      );
      out(result);
      if (!flags.json)
        console.log(
          `created feedback conversation #${result.thread.id} (comment ${result.comment.id})`,
        );
    } else if (action === "reply") {
      if (!flags.pr) fail("--pr is required");
      const result = await runOp(async () =>
        s.diffFeedback.reply(
          repo,
          Number(flags.pr),
          Number(target),
          flags.body ?? "",
          await writeSession(),
        ),
      );
      out(result);
      if (!flags.json)
        console.log(
          `replied to feedback thread #${result.thread.id} (message ${result.reply.id})`,
        );
    } else if (action === "resolve" || action === "reopen") {
      if (!flags.pr) fail("--pr is required");
      const thread = await runOp(async () =>
        s.diffFeedback.resolve(
          repo,
          Number(flags.pr),
          Number(target),
          action === "resolve",
          await writeSession(),
        ),
      );
      out(thread);
      if (!flags.json)
        console.log(
          `${action === "resolve" ? "resolved" : "reopened"} feedback thread #${thread.id}`,
        );
    } else if (action === "react") {
      if (!flags.pr) fail("--pr is required");
      if (!flags.emoji) fail("--emoji is required");
      const emoji = flags.emoji;
      const message = await runOp(async () =>
        s.diffFeedback.react(
          repo,
          Number(flags.pr),
          Number(target),
          emoji,
          await writeSession(),
        ),
      );
      out(message);
      if (!flags.json)
        console.log(`reacted to feedback message #${message.id} with ${emoji}`);
    } else usage();
  } else if (sub === "list") {
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
    const diff = await runOp(() => s.pulls.diff(repo, Number(rest[0])));
    if (flags.json) out(diff);
    else
      diff.files.forEach((f) => {
        console.log(
          `--- ${f.path} (+${f.additions} -${f.deletions})\n${f.patch}`,
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
    if (rest[0] === "react") {
      if (!flags.pr) fail("--pr is required");
      if (!flags.emoji) fail("--emoji is required");
      const emoji = flags.emoji;
      const c = await runOp(async () =>
        s.comments.reactForPull(
          repo,
          Number(flags.pr),
          Number(rest[1]),
          emoji,
          await writeSession(),
        ),
      );
      out(c);
      if (!flags.json)
        console.log(`reacted to PR comment #${c.id} with ${emoji}`);
    } else {
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
    }
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
    if (rest[0] === "view") {
      if (!flags.review) fail("--review is required");
      const detail = await runOp(() =>
        s.reviews.get(repo, Number(rest[1]), Number(flags.review)),
      );
      out(detail);
      if (!flags.json) {
        console.log(
          `review #${detail.review.id}: ${detail.review.state} by @${detail.review.user.login}`,
        );
        if (detail.review.body) console.log(detail.review.body);
        for (const comment of detail.comments) {
          console.log(
            `comment #${comment.id}\t${comment.path}:${comment.line ?? "-"}\t${comment.body}`,
          );
        }
      }
      return;
    }
    // Two-channel review inputs (#1895): `--comments` (line comments) and `--ac-results` (per-
    // criterion grades). Each is inline JSON or a file path — stdin (`-`) is gone, so the two
    // channels never contend for it.
    const comments = flags.comments
      ? JSON.parse(readJsonArg(flags.comments)) // [{ path, line, side?, body }, ...]
      : undefined;
    const acResults = flags["ac-results"]
      ? JSON.parse(readJsonArg(flags["ac-results"])) // [{ criterion_id, verdict, note? }, ...]
      : undefined;
    const res = await runOp(async () =>
      s.reviews.create(
        repo,
        Number(rest[0]),
        {
          event: (flags.event || "comment").toUpperCase(),
          body: flags.body || "",
          ...(flags.model ? { model: flags.model } : {}),
          // Pin the review to an explicit commit (defaults to the PR's current head). A Workflow
          // Verify child passes the head SHA it was launched against (#1358).
          ...(flags.commit ? { headSha: flags.commit } : {}),
          comments,
          acResults,
        },
        await writeSession(),
      ),
    );
    out(res);
    // A verdict that contradicts its own grades is soft-warned, never rejected (#1896): the review
    // is stored as submitted and the inconsistency stays visible to the submitter and the human.
    for (const warning of res.warnings) console.error(`warning: ${warning}`);
    if (!flags.json)
      console.log(
        `review ${res.id} submitted: ${res.state} (${res.comments} line comment(s))`,
      );
  } else if (sub === "review-response") {
    const [action, numberText] = rest;
    const number = Number(numberText);
    if (!flags.review) fail("--review is required");
    const reviewId = Number(flags.review);
    if (action === "add") {
      if (flags.body === undefined) fail("--body is required");
      const response = await runOp(async () =>
        s.reviews.createResponse(
          repo,
          number,
          {
            reviewId,
            ...(flags["review-comment"]
              ? { reviewCommentId: Number(flags["review-comment"]) }
              : {}),
            body: flags.body ?? "",
          },
          await writeSession(),
        ),
      );
      out(response);
      if (!flags.json)
        console.log(
          `responded to review #${response.pull_request_review_id} (response ${response.id})`,
        );
    } else if (action === "list") {
      const responses = await runOp(() =>
        s.reviews.listResponses(repo, number, reviewId),
      );
      out(responses);
      if (!flags.json)
        responses.forEach((response) => {
          console.log(
            `#${response.id}\treview #${response.pull_request_review_id}${
              response.pull_request_review_comment_id
                ? ` comment #${response.pull_request_review_comment_id}`
                : ""
            }\t@${response.user.login}\t${response.body}`,
          );
        });
    } else usage();
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
