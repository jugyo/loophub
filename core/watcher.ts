import { db } from "./db.ts";
import { localBranchRef, revParse } from "./git.ts";
import { currentPullStatus } from "./pull-mergeable-state.ts";
import * as S from "./store.ts";

// open PR の head ref を走査し、前回記録した sha から動いていれば
// pull_request.updated を発火する（GitHub の push→webhook 相当）。
// 初回（head_sha 未記録）は静かに記録するだけで発火しない。
export async function sweepPullUpdates(): Promise<any[]> {
  const emitted: any[] = [];
  for (const p of S.openPulls()) {
    const cur = await revParse(p.local_path, localBranchRef(p.head_ref));
    if (!cur) continue; // ブランチが見つからない場合はスキップ
    const status = await currentPullStatus(p);
    if (status) {
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
    }
    if (!p.head_sha) {
      S.setHeadSha(p.issue_id, cur);
      continue;
    }
    if (cur !== p.head_sha) {
      // The ref read is done; the observed SHA and the event announcing it commit together, so a
      // recorded SHA never suppresses the event a later sweep would otherwise emit for it.
      emitted.push(
        db.transaction(() => {
          S.setHeadSha(p.issue_id, cur);
          S.touchIssue(p.issue_id);
          return S.emitEvent(p.repo_id, "pull_request.updated", p.author, {
            number: p.number,
            sha: cur,
          });
        }),
      );
    }
  }
  return emitted;
}
