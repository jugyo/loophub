import { compareRepos } from "../repo-sort.ts";
import type {
  DashboardOverviewWire,
  DashboardRepositoryWire,
  LabelWire,
  RepoRefWire,
} from "../serialize.ts";
import { labelJSON } from "../serialize.ts";
import { issueListItemJSON, issueListItemsJSON } from "../serialize-status.ts";
import * as S from "../store.ts";

// ===== dashboard =====
// Cross-repo overview for the web top page: the most recently created open
// issues (newest first) and pull requests that are open and not yet merged.
// Each item carries its repo identity so the aggregated view can show which
// project it belongs to.
function repoRef(r: S.Repo): RepoRefWire {
  return { full_name: r.full_name, owner: r.owner, name: r.name };
}

function byCreatedDesc(
  a: { created_at: string },
  b: { created_at: string },
): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

// Cap for the cross-repo "recently created open issues" list. Bounds the git
// fan-out from enriching each issue's linked PR (issueListItemJSON below):
// serialization runs only after the slice, and only issues that actually have a
// linked PR spawn git — most have none — so this stays well under the per-issue
// worst case even at a higher cap than the open-PR section.
export const DASHBOARD_RECENT_ISSUES_LIMIT = 100;
/** Per-repository cap for the grouped home-page dashboard. */
export const DASHBOARD_REPOSITORY_ISSUES_LIMIT = 20;

function repositoryIssues(
  rows: S.IssueRow[],
  repo: S.Repo,
): Promise<DashboardRepositoryWire["issues"]> {
  const visibleRows = rows.slice(0, DASHBOARD_REPOSITORY_ISSUES_LIMIT);
  const subIssueRowsByParent = new Map<number, S.IssueRow[]>();
  const subIssuesTruncatedByParent = new Set<number>();

  for (const row of visibleRows) {
    const children = S.listSubIssues(row.id);
    if (children.length > 0) {
      subIssueRowsByParent.set(
        row.id,
        children.slice(0, S.MAX_ISSUE_DETAIL_SUB_ISSUES),
      );
    }
    if (children.length > S.MAX_ISSUE_DETAIL_SUB_ISSUES) {
      subIssuesTruncatedByParent.add(row.id);
    }
  }

  const allRows = [
    ...visibleRows,
    ...Array.from(subIssueRowsByParent.values()).flat(),
  ];
  const issueIds = allRows.map((row) => row.id);
  return issueListItemsJSON(visibleRows, repo, {
    labelsByIssue: S.labelsByIssue(issueIds),
    commentCountsByIssue: S.commentCountsByIssue(issueIds),
    linkedPullsByIssue: S.linkedPullsByIssue(issueIds),
    herdrPanesByIssue: S.issueHerdrPanesByIssue(repo.id, issueIds),
    subIssueSummariesByParent: S.subIssueSummariesByParent(issueIds),
    subIssueRowsByParent,
    subIssuesTruncatedByParent,
  });
}

export const dashboard = {
  async overview(labels: string[] = []): Promise<DashboardOverviewWire> {
    const repositories: DashboardRepositoryWire[] = [];
    const issueRows: { repo: S.Repo; ref: RepoRefWire; row: S.IssueRow }[] = [];
    const availableLabels = new Map<string, LabelWire>();
    const labelFilter = [
      ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
    ];
    for (const r of [...S.listRepos("active")].sort(compareRepos)) {
      const ref = repoRef(r);
      for (const label of S.listLabels(r.id)) {
        availableLabels.set(label.name, labelJSON(label));
      }
      let rows = S.listIssues(r.id, "issue", "all", "created", {
        rootsOnly: true,
      });
      if (labelFilter.length > 0) {
        const matchingIssueIds = S.issueIdsWithLabels(r.id, labelFilter);
        rows = rows.filter((row) => matchingIssueIds.has(row.id));
      }
      const openRows = rows.filter((row) => row.state === "open");
      const groupedIssues = await repositoryIssues(openRows, r);
      repositories.push({
        repo: ref,
        issues: groupedIssues,
        total_issues: rows.length,
        open_issues: openRows.length,
        closed_issues: rows.length - openRows.length,
        issue_limit: DASHBOARD_REPOSITORY_ISSUES_LIMIT,
        has_more: openRows.length > DASHBOARD_REPOSITORY_ISSUES_LIMIT,
      });
      for (const row of openRows) {
        issueRows.push({ repo: r, ref, row });
      }
    }
    // Cap the section before serialization so the list stays bounded and the
    // git fan-out (issueListItemJSON's linked-PR enrichment) stays bounded.
    // Issues are ordered newest-created first.
    issueRows.sort((a, b) => byCreatedDesc(a.row, b.row));
    // Enrich each issue's linked PR (status word + diff totals + the full
    // linked_pull_requests[] stack) so the home "Recent issues" rows match the
    // dedicated issue list's Pattern E sub-rows. issueListItemJSON is async per
    // the bounded git fan-out, hence Promise.all.
    const issues = await Promise.all(
      issueRows
        .slice(0, DASHBOARD_RECENT_ISSUES_LIMIT)
        .map(async ({ repo, ref, row }) => ({
          repo: ref,
          issue: await issueListItemJSON(row, repo),
        })),
    );
    // Surface the issue cap so the UI can note "showing the N most recent"
    // without duplicating the magic number client-side.
    const totalIssues = repositories.reduce(
      (sum, repository) => sum + repository.total_issues,
      0,
    );
    const totalOpenIssues = repositories.reduce(
      (sum, repository) => sum + repository.open_issues,
      0,
    );
    return {
      repositories,
      labels: [...availableLabels.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      repository_count: repositories.length,
      total_issues: totalIssues,
      total_open_issues: totalOpenIssues,
      total_closed_issues: totalIssues - totalOpenIssues,
      repository_issue_limit: DASHBOARD_REPOSITORY_ISSUES_LIMIT,
      issues,
      recent_issues_limit: DASHBOARD_RECENT_ISSUES_LIMIT,
      recentIssuesLimit: DASHBOARD_RECENT_ISSUES_LIMIT,
    };
  },
};
