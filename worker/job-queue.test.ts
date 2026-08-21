import { afterEach, expect, test, vi } from "vitest";
import {
  createJobQueue,
  DEFAULT_JOB_CONCURRENCY,
  normalizeJobConcurrency,
} from "./job-queue.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("normalizes invalid concurrency to the default", () => {
  expect(DEFAULT_JOB_CONCURRENCY).toBe(8);
  expect(normalizeJobConcurrency(Number.NaN)).toBe(DEFAULT_JOB_CONCURRENCY);
  expect(normalizeJobConcurrency(0)).toBe(DEFAULT_JOB_CONCURRENCY);
  expect(normalizeJobConcurrency(-1)).toBe(DEFAULT_JOB_CONCURRENCY);
  expect(normalizeJobConcurrency(1.5)).toBe(DEFAULT_JOB_CONCURRENCY);
  expect(normalizeJobConcurrency(4)).toBe(4);
});

test("claims up to the number of free slots on each tick", async () => {
  const queued = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const started: number[] = [];
  const release = new Map<number, () => void>();
  const queue = createJobQueue({
    concurrency: 2,
    claimNext: () => queued.shift() ?? null,
    run: (job) => {
      started.push(job.id);
      return new Promise<void>((resolve) => release.set(job.id, resolve));
    },
    onError: (error) => {
      throw error;
    },
  });

  queue.tick();
  await vi.waitFor(() => expect(started).toEqual([1, 2]));
  expect(queued.map((job) => job.id)).toEqual([3, 4]);
  expect(queue.runningCount()).toBe(2);

  release.get(1)?.();
  await vi.waitFor(() => expect(queue.runningCount()).toBe(1));
  queue.tick();
  await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
  expect(queue.runningCount()).toBe(2);

  release.get(2)?.();
  release.get(3)?.();
  await vi.waitFor(() => expect(queue.runningCount()).toBe(0));
});

test("a long-running job does not delay an unrelated queued job", async () => {
  const queued = [{ id: 1 }, { id: 2 }];
  let releaseFirst!: () => void;
  const started: number[] = [];
  const queue = createJobQueue({
    concurrency: 2,
    claimNext: () => queued.shift() ?? null,
    run: (job) => {
      started.push(job.id);
      if (job.id === 1)
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
    },
    onError: (error) => {
      throw error;
    },
  });

  queue.tick();
  await vi.waitFor(() => expect(started).toEqual([1, 2]));
  expect(queue.runningCount()).toBe(1);

  releaseFirst();
  await vi.waitFor(() => expect(queue.runningCount()).toBe(0));
});
