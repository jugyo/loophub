// JSON serializers: shape store rows into the stable wire objects that consumers
// (CLI now, JSON-RPC clients later) read. Kept separate from service.ts so the
// shaping is reusable and side-effect free.
import * as S from "./store.ts";
import { mergePreview, revParse } from "./git.ts";
import { linkedRef } from "./links.ts";

export function repoJSON(r: S.Repo) {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    owner: { login: r.owner },
    default_branch: r.default_branch,
    local_path: r.local_path,
    created_at: r.created_at,
    archived: !!r.archived,
    archived_at: r.archived_at ?? null,
  };
}

export function agentSessionJSON(row: any) {
  const out: any = {
    id: row.id,
    agent: row.agent,
    session: row.external_session,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.name) out.name = row.name;
  return out;
}

export function commentJSON(m: any) {
  return { id: m.id, user: { login: m.author }, body: m.body, created_at: m.created_at };
}

export function reviewJSON(v: any) {
  return {
    id: v.id,
    user: { login: v.author },
    state: v.event,
    body: v.body,
    submitted_at: v.created_at,
  };
}

export function reviewCommentJSON(m: any) {
  return {
    id: m.id,
    pull_request_review_id: m.review_id,
    user: { login: m.author },
    path: m.path,
    line: m.line,
    side: m.side,
    body: m.body,
    created_at: m.created_at,
  };
}

export function labelJSON(l: any) {
  return { name: l.name, color: l.color };
}

function linkedIssueSummary(repo: S.Repo, pullRowId: number) {
  const p = S.getPull(pullRowId);
  if (!p?.linked_issue_id) return null;
  const linked = S.getIssueById(p.linked_issue_id);
  if (!linked || linked.kind !== "issue") return null;
  return {
    number: linked.number,
    title: linked.title,
    state: linked.state,
    html_url: linkedRef(repo, "issues", linked.number).html_url,
  };
}

function linkedPullSummary(repo: S.Repo, issueRowId: number) {
  const pr = S.linkedPullForIssue(issueRowId);
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: !!pr.merged,
    html_url: linkedRef(repo, "pulls", pr.number).html_url,
  };
}

export function issueJSON(row: any, repo?: S.Repo) {
  const out: any = {
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    user: { login: row.author },
    assignee: S.assigneeJSON(row.assignee_session_id),
    agent_status: S.agentStatusJSON(row),
    labels: S.issueLabels(row.id).map(labelJSON),
    comments: S.countComments(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.kind === "pull") out.pull_request = { url: `/pulls/${row.number}` };
  else if (repo) out.linked_pull_request = linkedPullSummary(repo, row.id);
  return out;
}

export async function pullJSON(repo: S.Repo, row: any) {
  const p = S.getPull(row.id);
  const headSha = await revParse(repo.local_path, p.head_ref);
  const baseSha = await revParse(repo.local_path, p.base_ref);
  let mergeable: boolean | null = null;
  let mergeable_state = "unknown";
  if (!p.merged && headSha && baseSha) {
    const prev = await mergePreview(repo.local_path, p.base_ref, p.head_ref);
    mergeable = !prev.conflict;
    mergeable_state = prev.conflict ? "dirty" : "clean";
  }
  return {
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    user: { login: row.author },
    head: { ref: p.head_ref, sha: headSha },
    base: { ref: p.base_ref, sha: baseSha },
    merged: !!p.merged,
    mergeable,
    mergeable_state,
    merge_commit_sha: p.merge_commit_sha,
    review_state: S.computeReviewState(row.id),
    changes_addressed_at: p.changes_addressed_at ?? null,
    changes_addressed_by: p.changes_addressed_by ?? null,
    labels: S.issueLabels(row.id).map(labelJSON),
    comments: S.countComments(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    linked_issue: linkedIssueSummary(repo, row.id),
  };
}
