export const DEFAULT_JOB_CONCURRENCY = 8;

export function normalizeJobConcurrency(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_JOB_CONCURRENCY;
}

export function createJobQueue<T extends { id: number }>(input: {
  concurrency: number;
  claimNext: () => T | null;
  run: (job: T) => Promise<void> | void;
  onError: (error: unknown) => void;
}): { tick: () => void; runningCount: () => number } {
  const running = new Set<number>();

  const tick = () => {
    while (running.size < input.concurrency) {
      const job = input.claimNext();
      if (!job) return;
      running.add(job.id);
      Promise.resolve()
        .then(() => input.run(job))
        .catch(input.onError)
        .finally(() => running.delete(job.id));
    }
  };

  return {
    tick,
    runningCount: () => running.size,
  };
}
