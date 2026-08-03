import { db } from "./db.ts";
import { currentMergeableState } from "./pull-mergeable-state.ts";
import * as S from "./store.ts";

const MERGE_READY_NOTIFICATION_DELAY_MS = 10_000;

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
    // The mergeable state comes from git and GitHub, so it is resolved before the PR's observation,
    // notification and event commit as one.
    const state = await currentMergeableState(pull);
    const row = db.transaction(() => {
      const observed = S.recordMergeReadyState(
        pull.repo_id,
        pull.number,
        state,
      );
      if (observed.state !== "clean") return null;
      const cleanSince = Date.parse(observed.updated_at);
      if (
        !Number.isFinite(cleanSince) ||
        Date.now() - cleanSince < MERGE_READY_NOTIFICATION_DELAY_MS
      )
        return null;

      const notification = S.createNotification({
        repoId: pull.repo_id,
        kind: "merge_ready",
        title: "Ready to merge",
        body: `PR #${pull.number} in ${pull.repo_full_name} is ready to merge.`,
        resourceKind: "pull",
        resourceNumber: pull.number,
        sourceKey: `merge-ready:${pull.repo_id}:${pull.number}:${observed.transition_count}`,
      });
      if (!notification) return null;
      S.emitEvent(notification.repo_id, "notification.created", "loophub", {
        id: notification.id,
        kind: notification.kind,
        number: notification.resource_number,
      });
      return notification;
    });
    if (row) created.push(row);
  }
  return { checked: pulls.length, created };
}
