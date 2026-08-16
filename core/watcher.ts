import { db } from "./db.ts";
import { currentPullStatus } from "./pull-mergeable-state.ts";
import * as S from "./store.ts";

// open PR の head ref を走査し、前回記録した sha から動いていれば
// pull_request.updated を発火する（GitHub の push→webhook 相当）。
// 初回（head_sha 未記録）は静かに記録するだけで発火しない。
export async function sweepPullUpdates(): Promise<any[]> {
  const emitted: any[] = [];
  S.prunePullDiffProjections();
  for (const p of S.openPulls()) {
    const previousProjection = S.getCurrentPullStatusProjection(p.issue_id);
    const status = await currentPullStatus(p);
    if (!status) {
      if (previousProjection) {
        const event = db.transaction(() => {
          S.deleteCurrentPullStatusProjection(p.issue_id);
          S.touchIssue(p.issue_id);
          return S.emitEvent(p.repo_id, "pull_request.updated", p.author, {
            number: p.number,
            sha: null,
          });
        });
        emitted.push(event);
      }
      continue; // ref が解決不能な間は stale な projection を公開しない
    }
    const projectionChanged =
      previousProjection !== null &&
      (previousProjection.base_sha !== status.baseSha ||
        previousProjection.head_sha !== status.headSha);
    const cur = status.headSha;
    if (!p.head_sha) {
      db.transaction(() => {
        S.upsertPullStatusProjection({
          baseSha: status.baseSha,
          headSha: status.headSha,
          mergeable: status.mergeable,
          mergeableState: status.mergeable_state,
          hasEffectiveDiff: status.hasEffectiveDiff,
          conflict: status.conflict,
          additions: status.additions,
          deletions: status.deletions,
          changedFiles: status.changedFiles,
          commitsAhead: status.commitsAhead,
        });
        S.upsertCurrentPullStatusProjection({
          issueId: p.issue_id,
          baseSha: status.baseSha,
          headSha: status.headSha,
          mergeable: status.mergeable,
          mergeableState: status.mergeable_state,
          hasEffectiveDiff: status.hasEffectiveDiff,
          conflict: status.conflict,
          additions: status.additions,
          deletions: status.deletions,
          changedFiles: status.changedFiles,
          commitsAhead: status.commitsAhead,
          baseCommitsBehind: status.baseCommitsBehind,
        });
        S.setHeadSha(p.issue_id, cur);
      });
      continue;
    }
    // The projection and the event announcing its SHA pair commit together, so a recorded
    // projection never suppresses the event a later sweep would otherwise emit for it.
    const event = db.transaction(() => {
      S.upsertPullStatusProjection({
        baseSha: status.baseSha,
        headSha: status.headSha,
        mergeable: status.mergeable,
        mergeableState: status.mergeable_state,
        hasEffectiveDiff: status.hasEffectiveDiff,
        conflict: status.conflict,
        additions: status.additions,
        deletions: status.deletions,
        changedFiles: status.changedFiles,
        commitsAhead: status.commitsAhead,
      });
      S.upsertCurrentPullStatusProjection({
        issueId: p.issue_id,
        baseSha: status.baseSha,
        headSha: status.headSha,
        mergeable: status.mergeable,
        mergeableState: status.mergeable_state,
        hasEffectiveDiff: status.hasEffectiveDiff,
        conflict: status.conflict,
        additions: status.additions,
        deletions: status.deletions,
        changedFiles: status.changedFiles,
        commitsAhead: status.commitsAhead,
        baseCommitsBehind: status.baseCommitsBehind,
      });
      if (cur !== p.head_sha || projectionChanged) {
        S.setHeadSha(p.issue_id, cur);
        S.touchIssue(p.issue_id);
        return S.emitEvent(p.repo_id, "pull_request.updated", p.author, {
          number: p.number,
          sha: cur,
        });
      }
      return null;
    });
    if (event) emitted.push(event);
  }
  return emitted;
}
