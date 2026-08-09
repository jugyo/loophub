import type {
  IssueDetailPageWire,
  IssueListPageWire,
  PullDetailPageWire,
} from "../serialize.ts";
import { comments } from "./comments.ts";
import { diffFeedbackForDiff } from "./diff-feedback.ts";
import { issues } from "./issues.ts";
import { labels } from "./labels.ts";
import { pullDiffFiles, pulls } from "./pulls.ts";
import { repos } from "./repos.ts";
import { reviews } from "./reviews.ts";
import { actorFor } from "./shared.ts";
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
    return {
      issues: issueRows,
      repo,
      workspaces: workspaceRows,
      labels: labelRows,
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
    // uncacheable git cost: its operands are ref names, so the git-command cache cannot help.
    const diff = await pullDiffFiles(name, number);
    const [pull, reviewRows, lineComments, commentRows] = await Promise.all([
      pulls.get(name, number, {
        withComments: false,
        diffBaseSha: diff.baseSha,
      }),
      reviews.list(name, number),
      reviews.listComments(name, number),
      comments.list(name, number, actor),
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
    return {
      pull,
      files: diff.files,
      reviews: reviewRows,
      line_comments: lineComments,
      comments: commentRows,
      diff_feedback: {
        comment_counts: orphaned.comment_counts,
        orphaned_threads: orphaned.threads,
      },
    };
  },
};
