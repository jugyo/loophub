import { commitsAhead, mergePreview, revParse } from "./git.ts";
import type { MergeableState } from "./mergeable.ts";
import { resolveMergeable } from "./mergeable.ts";
import * as S from "./store.ts";

async function currentMergeableState(
  pull: S.OpenPullSweepRow,
): Promise<MergeableState> {
  const [headSha, baseSha] = await Promise.all([
    revParse(pull.local_path, pull.head_ref),
    revParse(pull.local_path, pull.base_ref),
  ]);
  if (!headSha || !baseSha) return "unknown";

  const [preview, ahead] = await Promise.all([
    mergePreview(pull.local_path, pull.base_ref, pull.head_ref),
    commitsAhead(pull.local_path, pull.base_ref, pull.head_ref),
  ]);
  const reviewGate = S.computeReviewGate(pull.issue_id, headSha);
  return resolveMergeable({
    hasCommits: ahead > 0,
    conflict: preview.conflict,
    reviewed: reviewGate.reviewed,
    allTopicsPassed: reviewGate.allTopicsPassed,
  }).mergeable_state;
}

export interface MergeReadyNotificationSweepResult {
  checked: number;
  created: S.NotificationRow[];
}

// Reconcile every open PR's current mergeable state with its last observed state. The transition
// count is stable while the PR remains clean, so createNotification's unique source key makes this
// safe to call from both notification reads and the resident worker sweep.
export async function sweepMergeReadyNotifications(): Promise<MergeReadyNotificationSweepResult> {
  const created: S.NotificationRow[] = [];
  const pulls = S.openPulls();
  for (const pull of pulls) {
    const state = await currentMergeableState(pull);
    const observed = S.recordMergeReadyState(pull.repo_id, pull.number, state);
    if (observed.state !== "clean") continue;

    const row = S.createNotification({
      repoId: pull.repo_id,
      kind: "merge_ready",
      title: "Ready to merge",
      body: `PR #${pull.number} in ${pull.repo_full_name} is ready to merge.`,
      resourceKind: "pull",
      resourceNumber: pull.number,
      sourceKey: `merge-ready:${pull.repo_id}:${pull.number}:${observed.transition_count}`,
    });
    if (!row) continue;
    created.push(row);
    S.emitEvent(row.repo_id, "notification.created", "loophub", {
      id: row.id,
      kind: row.kind,
      number: row.resource_number,
    });
  }
  return { checked: pulls.length, created };
}
