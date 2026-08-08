import type {
  IssueDetailPageWire,
  IssueListPageWire,
  PullDetailPageWire,
} from "../serialize.ts";
import { comments } from "./comments.ts";
import { issues } from "./issues.ts";
import { labels } from "./labels.ts";
import { pulls } from "./pulls.ts";
import { repos } from "./repos.ts";
import { reviews } from "./reviews.ts";
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
  ): Promise<PullDetailPageWire> {
    const [pull, files, reviewRows, lineComments, commentRows] =
      await Promise.all([
        pulls.get(name, number, { withComments: false }),
        pulls.files(name, number),
        reviews.list(name, number),
        reviews.listComments(name, number),
        comments.list(name, number, actor),
      ]);
    pull.comment_list = commentRows;
    return {
      pull,
      files,
      reviews: reviewRows,
      line_comments: lineComments,
      comments: commentRows,
    };
  },
};
