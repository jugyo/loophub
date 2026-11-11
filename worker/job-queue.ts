export const DEFAULT_JOB_CONCURRENCY = 8;

export function normalizeJobConcurrency(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_JOB_CONCURRENCY;
}

export function createJobQueue<T extends { id: number }>(input: {
  concurrency: number;
  claimNext: () => T | null;
  run: (job: T) => Promise<void> | void;
  onError: (error: unknown) => void;
}): {
  tick: () => void;
  runningCount: () => number;
  runningIds: () => number[];
  stop: () => void;
  drain: (timeoutMs: number) => Promise<boolean>;
} {
  const running = new Set<number>();
  const idle = new Set<() => void>();
  let stopped = false;

  const tick = () => {
    while (!stopped && running.size < input.concurrency) {
      const job = input.claimNext();
      if (!job) return;
      running.add(job.id);
      Promise.resolve()
        .then(() => input.run(job))
        .catch(input.onError)
        .finally(() => {
          running.delete(job.id);
          if (running.size === 0) for (const resolve of idle) resolve();
        });
    }
  };

  // Resolves true once every claimed job settles, or false when the grace period runs out first.
  const drain = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      if (running.size === 0) return resolve(true);
      const done = (drained: boolean) => {
        clearTimeout(timer);
        idle.delete(onIdle);
        resolve(drained);
      };
      const onIdle = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      idle.add(onIdle);
    });

  return {
    tick,
    runningCount: () => running.size,
    runningIds: () => [...running],
    stop: () => {
      stopped = true;
    },
    drain,
  };
}
