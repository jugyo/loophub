import { sweepPullConflicts } from "../core/pull-conflict-events.ts";
import type { EventRow } from "../core/store.ts";
import * as S from "../core/store.ts";
import { workerLog } from "./logger.ts";

export type ConflictSweepTrigger = number | "periodic";

export interface ConflictSweepTarget {
  repoId: number;
  baseRef: string;
  triggerEventId: ConflictSweepTrigger;
}

export interface ConflictSweepResult {
  checked: number;
  emitted: number;
}

export interface ConflictCoordinator {
  enqueue(target: ConflictSweepTarget): Promise<ConflictSweepResult>;
  enqueueAll(
    triggerEventId?: ConflictSweepTrigger,
  ): Promise<ConflictSweepResult>;
  enqueueMergedEvent(row: EventRow): void;
}

export interface ConflictCoordinatorOptions {
  sweep?: (
    target: Pick<ConflictSweepTarget, "repoId" | "baseRef">,
  ) => Promise<ConflictSweepResult>;
}

interface PendingRequest {
  resolve: (result: ConflictSweepResult) => void;
  reject: (error: unknown) => void;
}

interface KeyState {
  running: boolean;
  pending: ConflictSweepTarget | null;
  requests: PendingRequest[];
}

const keyFor = (repoId: number, baseRef: string) => `${repoId}\0${baseRef}`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function mergedPullTarget(
  row: EventRow,
): { repoId: number; baseRef: string } | null {
  if (row.type !== "pull_request.merged" || row.repo_id == null) return null;
  const payload = parsePayload(row.payload);
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { sha?: unknown }).sha !== "string" ||
    !(payload as { sha: string }).sha
  )
    return null;
  const number = (payload as { number?: unknown }).number;
  if (typeof number !== "number") return null;
  const issue = S.getIssue(row.repo_id, number);
  if (!issue) return null;
  const pull = S.getPull(issue.id);
  if (!pull) return null;
  return { repoId: row.repo_id, baseRef: pull.base_ref };
}

export function createConflictCoordinator(
  options: ConflictCoordinatorOptions = {},
): ConflictCoordinator {
  const states = new Map<string, KeyState>();
  const sweep =
    options.sweep ??
    ((target: Pick<ConflictSweepTarget, "repoId" | "baseRef">) =>
      sweepPullConflicts(target));

  const run = async (key: string, state: KeyState): Promise<void> => {
    state.running = true;
    let result: ConflictSweepResult;
    try {
      const target = state.pending;
      state.pending = null;
      if (!target) throw new Error(`missing conflict sweep target key=${key}`);
      const startedAt = Date.now();
      workerLog.info(
        `lh-worker: conflict recheck started trigger_event_id=${target.triggerEventId} repo_id=${target.repoId} base_ref=${target.baseRef}`,
      );
      result = await sweep({
        repoId: target.repoId,
        baseRef: target.baseRef,
      });
      workerLog.info(
        `lh-worker: conflict recheck completed trigger_event_id=${target.triggerEventId} repo_id=${target.repoId} base_ref=${target.baseRef} checked=${result.checked} emitted=${result.emitted} duration_ms=${Date.now() - startedAt}`,
      );
    } catch (error) {
      workerLog.error(
        `lh-worker: conflict recheck failed key=${key} error=${errorMessage(error)}`,
      );
      for (const request of state.requests) request.reject(error);
      state.requests = [];
      state.pending = null;
      state.running = false;
      states.delete(key);
      return;
    }

    if (state.pending) {
      await run(key, state);
      return;
    }

    for (const request of state.requests) request.resolve(result);
    state.requests = [];
    state.running = false;
    states.delete(key);
  };

  const enqueue = (
    target: ConflictSweepTarget,
  ): Promise<ConflictSweepResult> => {
    const key = keyFor(target.repoId, target.baseRef);
    let state = states.get(key);
    const promise = new Promise<ConflictSweepResult>((resolve, reject) => {
      if (!state) {
        state = { running: false, pending: target, requests: [] };
        states.set(key, state);
      } else if (state.running) {
        state.pending = target;
      } else {
        state.pending = target;
      }
      state.requests.push({ resolve, reject });
    });
    if (state && !state.running) void run(key, state);
    return promise;
  };

  return {
    enqueue,
    async enqueueAll(triggerEventId = "periodic") {
      const targets = new Map<string, ConflictSweepTarget>();
      for (const pull of S.openPulls()) {
        const target = {
          repoId: pull.repo_id,
          baseRef: pull.base_ref,
          triggerEventId,
        } satisfies ConflictSweepTarget;
        targets.set(keyFor(target.repoId, target.baseRef), target);
      }
      const results = await Promise.all([...targets.values()].map(enqueue));
      return results.reduce(
        (total, result) => ({
          checked: total.checked + result.checked,
          emitted: total.emitted + result.emitted,
        }),
        { checked: 0, emitted: 0 },
      );
    },
    enqueueMergedEvent(row) {
      try {
        const target = mergedPullTarget(row);
        if (!target) return;
        void enqueue({
          repoId: target.repoId,
          baseRef: target.baseRef,
          triggerEventId: row.id,
        }).catch(() => {
          // coordinator が相関キー付きで失敗を記録する。
        });
      } catch (error) {
        workerLog.error(
          `lh-worker: conflict recheck enqueue failed trigger_event_id=${row.id} error=${errorMessage(error)}`,
        );
      }
    },
  };
}
