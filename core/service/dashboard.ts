import { issueListItemJSON } from "../serialize-status.ts";
import * as S from "../store.ts";

// ===== dashboard =====
// Cross-repo overview for the web top page: the most recently created open
// issues (newest first) and pull requests that are open and not yet merged.
// Each item carries its repo identity so the aggregated view can show which
// project it belongs to.
type RepoRef = { full_name: string; owner: string; name: string };

function repoRef(r: S.Repo): RepoRef {
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

export const dashboard = {
  async overview() {
    const issueRows: { repo: S.Repo; ref: RepoRef; row: S.IssueRow }[] = [];
    for (const r of S.listRepos("active")) {
      const ref = repoRef(r);
      for (const row of S.listIssues(r.id, "issue", "open", "created", {
        rootsOnly: true,
      })) {
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
    return { issues, recentIssuesLimit: DASHBOARD_RECENT_ISSUES_LIMIT };
  },
};
