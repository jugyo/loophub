import {
  actorFor,
  ensureWritable,
  issueGroupJSON,
  issueJSON,
  issueOr404,
  repoOr404,
  S,
  ServiceError,
} from "./shared.ts";

// ===== issue groups (#312) =====
// A bolt-on, repo-scoped grouping of issues to work through in order (data model in db.ts/store.ts).
// Membership is many-to-many with a per-group order; the issues table is never touched. Groups are
// identified to callers by their numeric id (names are mutable and only unique within a repo).
function issueGroupOr404(r: S.Repo, id: number): any {
  const g = S.getIssueGroupById(id);
  if (!g || g.repo_id !== r.id) throw new ServiceError(404, "Not Found");
  return g;
}

// An issue group only collects real issues (kind='issue'), not PRs — PRs are tracked via their
// linked issue. Resolve a member by issue *number* (the caller-facing identifier) like every other
// issue-addressed procedure.
function groupIssueOr404(r: S.Repo, number: number): any {
  return issueOr404(r, number, "issue");
}

export const issueGroups = {
  list(name: string) {
    const r = repoOr404(name);
    return S.listIssueGroups(r.id).map(issueGroupJSON);
  },

  get(name: string, id: number) {
    const r = repoOr404(name);
    return issueGroupJSON(issueGroupOr404(r, id));
  },

  // Ordered issues in a group (by insertion position). Returns full issue objects.
  members(name: string, id: number) {
    const r = repoOr404(name);
    const g = issueGroupOr404(r, id);
    return S.listGroupMembers(g.id).map((row) => issueJSON(row, r));
  },

  // Groups the given issue belongs to, each with its ordered members (#314). Powers the
  // "other issues in the same group" list on the issue detail view. The issue itself is included
  // in each group's `members` (the caller filters it out); membership is many-to-many, so an issue
  // can appear under several groups. Returns [] when the issue belongs to no group.
  forIssue(name: string, number: number) {
    const r = repoOr404(name);
    const issue = groupIssueOr404(r, number);
    return S.listGroupsForIssue(issue.id).map((g) => ({
      group: issueGroupJSON(g),
      members: S.listGroupMembers(g.id).map((row) => issueJSON(row, r)),
    }));
  },

  create(name: string, groupName: string, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const trimmed = (groupName ?? "").trim();
    if (!trimmed) throw new ServiceError(422, "name is required");
    if (S.getIssueGroupByName(r.id, trimmed))
      throw new ServiceError(422, `group already exists: ${trimmed}`);
    const actor = actorFor(sessionId);
    const row = S.createIssueGroup(r.id, trimmed);
    // session identity is carried by `actor` (actorFor resolves the session), matching the
    // pre-existing issue.* events — no separate session_id field in the payload.
    S.emitEvent(r.id, "issue_group.created", actor, {
      group_id: row.id,
      name: trimmed,
    });
    return issueGroupJSON(row);
  },

  rename(
    name: string,
    id: number,
    groupName: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const g = issueGroupOr404(r, id);
    const trimmed = (groupName ?? "").trim();
    if (!trimmed) throw new ServiceError(422, "name is required");
    const clash = S.getIssueGroupByName(r.id, trimmed);
    if (clash && clash.id !== g.id)
      throw new ServiceError(422, `group already exists: ${trimmed}`);
    const actor = actorFor(sessionId);
    const row = S.renameIssueGroup(g.id, trimmed);
    S.emitEvent(r.id, "issue_group.renamed", actor, {
      group_id: g.id,
      name: trimmed,
    });
    return issueGroupJSON(row);
  },

  remove(name: string, id: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const g = issueGroupOr404(r, id);
    const actor = actorFor(sessionId);
    S.deleteIssueGroup(g.id);
    S.emitEvent(r.id, "issue_group.deleted", actor, {
      group_id: g.id,
      name: g.name,
    });
    return { deleted: true, id: g.id };
  },

  // Add an issue (by number) to a group; appends to the group's order. Idempotent — re-adding an
  // existing member is a no-op (no event) and returns the unchanged group.
  addIssue(
    name: string,
    id: number,
    issueNumber: number,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const g = issueGroupOr404(r, id);
    const issue = groupIssueOr404(r, issueNumber);
    const actor = actorFor(sessionId);
    if (S.addIssueToGroup(g.id, issue.id)) {
      S.emitEvent(r.id, "issue_group.issue_added", actor, {
        group_id: g.id,
        number: issue.number,
      });
    }
    return issueGroupJSON(S.getIssueGroupById(g.id));
  },

  // Remove an issue (by number) from a group. No-op (no event) if it was not a member.
  removeIssue(
    name: string,
    id: number,
    issueNumber: number,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const g = issueGroupOr404(r, id);
    const issue = groupIssueOr404(r, issueNumber);
    const actor = actorFor(sessionId);
    if (S.removeIssueFromGroup(g.id, issue.id)) {
      S.emitEvent(r.id, "issue_group.issue_removed", actor, {
        group_id: g.id,
        number: issue.number,
      });
    }
    return issueGroupJSON(S.getIssueGroupById(g.id));
  },
};
