import type { HerdrRepoSessionsWire, HerdrSessionsWire } from "../serialize.ts";

// Structural digest of a terminal/sessions snapshot for the worker sweep's change detection
// (#1665). The sweep emits a terminal.sessions_updated event only when this digest changes, so the
// digest must cover everything a client renders — agents, their idle/working status, PR linkage,
// and the pull/issue workspace badges — but deliberately EXCLUDE volatile token usage
// (session.usage): agents burn tokens continuously, so folding usage in would make the digest
// differ every tick and defeat the "emit only on change" goal (the acceptance criterion that the
// events table and client invalidation stay calm with 20-30 busy agents). Usage still rides along
// on the snapshot payload; it is simply refreshed opportunistically on the next structural change
// rather than driving its own event storm.
//
// The digest is order-independent: repos and agents are sorted by their stable ids so a herdr
// output reordering alone is not treated as a change.

function repoSignature(repo: HerdrRepoSessionsWire): unknown {
  return {
    repo: repo.repo,
    session_name: repo.session_name,
    agents: repo.agents
      .map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        pull: a.pull,
        pull_closed: a.pull_closed,
        focusable: a.focusable,
        workflow: a.workflow ?? null,
        // Session identity is structural; its token usage is not (see the module comment).
        session: a.session?.id ?? null,
      }))
      .sort((x, y) => x.id.localeCompare(y.id)),
    pull_workspaces: [...repo.pull_workspaces].sort((x, y) => x.pull - y.pull),
    issue_workspaces: [...repo.issue_workspaces].sort(
      (x, y) => x.issue - y.issue,
    ),
    // Whether the group is live or carried over from a failed capture is displayed state, and
    // stale_since is frozen at the first failure — so a repo that keeps failing emits one event
    // on the transition rather than one per tick (#2142).
    stale_since: repo.stale_since ?? null,
  };
}

export function herdrSnapshotSignature(snapshot: HerdrSessionsWire): string {
  return JSON.stringify({
    running_repos: [...(snapshot.running_repos ?? [])].sort(),
    session_list_capture_failed: snapshot.session_list_capture_failed ?? false,
    capture_failed_repos: [...(snapshot.capture_failed_repos ?? [])].sort(),
    repos: snapshot.repos
      .map(repoSignature)
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
  });
}
