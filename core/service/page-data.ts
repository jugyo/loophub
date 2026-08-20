import type {
  IssueDetailPageWire,
  IssueListPageWire,
  PullDetailPageWire,
  PullTimelineItemWire,
} from "../serialize.ts";
import { comments } from "./comments.ts";
import { diffFeedbackForDiff } from "./diff-feedback.ts";
import { issues } from "./issues.ts";
import { labels } from "./labels.ts";
import { pullDiffFiles, pulls } from "./pulls.ts";
import { repos } from "./repos.ts";
import { reviews } from "./reviews.ts";
import { actorFor } from "./shared.ts";
import { workflowRuns } from "./workflow-runs.ts";
import { workspaces } from "./workspaces.ts";

export const pageData = {
  async issueList(
    name: string,
    opts: {
      state?: string;
      labels?: string[];
      workspace?: string;
      lookahead?: boolean;
      page?: number;
      perPage?: number;
      includeLabels?: boolean;
    } = {},
  ): Promise<IssueListPageWire> {
    const [issueRows, repo, workspaceRows, labelRows] = await Promise.all([
      issues.list(name, {
        kind: "issue",
        state: opts.state,
        labels: opts.labels,
        workspace: opts.workspace,
        lookahead: opts.lookahead,
        page: opts.page,
        perPage: opts.perPage,
      }),
      repos.get(name),
      workspaces.list(name),
      opts.includeLabels ? labels.list(name) : [],
    ]);
    // #112: the mini tracker on each linked-PR sub-row needs the run's display state. Selecting it
    // with the page keeps a Workflow event to one refetch — asking per row put one request per row
    // on lh-web's single event loop, and every workflow_run.* / workflow_step.* event invalidated
    // all of them at once. The linked PR status itself is read from the worker projection.
    const linkedPulls = issueRows.flatMap((issue) =>
      // Same fallback the row renderer uses (web/src/components/dashboard-rows.tsx): a response
      // shape carrying only the singular field still gets its row seeded.
      (
        issue.linked_pull_requests ??
        (issue.linked_pull_request ? [issue.linked_pull_request] : [])
      ).map((pull) => pull.number),
    );
    return {
      issues: issueRows,
      repo,
      workspaces: workspaceRows,
      labels: labelRows,
      workflow_runs: await workflowRuns.statesForPulls(name, {
        pulls: linkedPulls,
      }),
    };
  },

  async issueDetail(
    name: string,
    number: number,
    actor?: string,
  ): Promise<IssueDetailPageWire> {
    const [issue, commentRows, acceptanceCriteria] = await Promise.all([
      issues.get(name, number, {
        withComments: false,
        withAcceptanceCriteria: false,
      }),
      comments.list(name, number, actor),
      issues.acList(name, number),
    ]);
    issue.comment_list = commentRows;
    issue.acceptance_criteria = acceptanceCriteria
      .filter((criterion) => criterion.enabled)
      .map(({ enabled: _enabled, ...criterion }) => criterion);
    return {
      issue,
      comments: commentRows,
      acceptance_criteria: acceptanceCriteria,
    };
  },

  async pullDetail(
    name: string,
    number: number,
    actor?: string,
    sessionId?: string | null,
  ): Promise<PullDetailPageWire> {
    // Everything on this screen that depends on the PR's live diff base — Files changed, the
    // commit list on the PR row, and the diff feedback anchors — sits on the same base, so
    // resolve it once here and hand it to the rest (#123). The resolution is the request's one
    // The operands are ref names, so resolve the live diff base once for this request.
    const diff = await pullDiffFiles(name, number);
    const [pull, reviewRows, lineComments, commentRows, githubTimeline] =
      await Promise.all([
        pulls.get(name, number, {
          withComments: false,
          diffBaseShas: diff.baseShas,
        }),
        reviews.list(name, number),
        reviews.listComments(name, number),
        comments.list(name, number, actor),
        pulls.githubTimeline(name, number),
      ]);
    pull.comment_list = commentRows;
    // Read the threads as the caller, not as the page: `diffFeedback/list` resolves its actor
    // from the session, and a mismatch would show a reader their own reactions as unreacted.
    const orphaned = diffFeedbackForDiff(
      name,
      number,
      diff,
      { orphaned: true },
      actorFor(sessionId),
    );
    // #145: the whole PR activity as one chronological list, folded out of data this request
    // already fetched — the git commit list on the PR row, reviews and comments —
    // so assembly adds no git, query or HTTP work of its own. Stable sort keeps the insertion
    // order below for entries sharing a timestamp.
    const timeline: PullTimelineItemWire[] = [
      // pull.commits is newest first; feed it oldest first so same-second commits stay in commit
      // order after the chronological stable sort below.
      ...[...(pull.commits ?? [])].reverse().map((commit) => ({
        kind: "commit" as const,
        created_at: commit.date,
        commit,
      })),
      ...reviewRows.map((review) => ({
        kind: "review" as const,
        created_at: review.submitted_at,
        review,
      })),
      ...commentRows.map((comment) => ({
        kind: "comment" as const,
        created_at: comment.created_at,
        comment,
      })),
      // #2500: what the worker already observed on the linked GitHub PR, read from the DB rather
      // than fetched, so this stays as free as the rest of the assembly. Empty when the PR has no
      // linked GitHub PR.
      ...githubTimeline,
    ].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    return {
      pull,
      files: diff.files,
      reviews: reviewRows,
      line_comments: lineComments,
      comments: commentRows,
      timeline,
      diff_feedback: {
        comment_counts: orphaned.comment_counts,
        orphaned_threads: orphaned.threads,
      },
    };
  },
};
