import { formatEvent, type LoopEvent } from "../events.ts";
import * as S from "../store.ts";
import { workflowSubscriptionLowerBound } from "../workflow/source-events.ts";
import {
  logWorkflowWatcher,
  type WorkflowWatcherLogEntry,
} from "../workflow-watcher-log.ts";

export type WorkflowEventWaitInput = {
  repo: string;
  run: S.WorkflowRunRow;
  since: number;
};

type WorkflowWatchDeps = {
  /** The run's subscription lower bound, or null when its start was never recorded. */
  startedEventId(run: S.WorkflowRunRow): number | null;
  readNextEvent(input: {
    repoId: number;
    runId: number;
    issueNumber: number;
    prNumber: number;
    afterId: number;
  }): S.EventRow | null | Promise<S.EventRow | null>;
  wait(): void | Promise<void>;
  log?(entry: WorkflowWatcherLogEntry): void;
};

function inputError(message: string): never {
  throw new Error(`workflow event: ${message}`);
}

function validateRepo(repo: string): void {
  const parts = repo.split("/");
  if (
    repo.startsWith("-") ||
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(part),
    )
  ) {
    inputError(`invalid --repo: ${repo}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateEffect(effect: string): void {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(effect)) {
    inputError(`invalid --effect: ${effect}`);
  }
}

function runInRepo(input: { repo: string; run: number }): S.WorkflowRunRow {
  const [owner, name] = input.repo.split("/");
  const repo = S.getRepo(owner, name);
  if (!repo) inputError(`repository not found: ${input.repo}`);
  const run = S.getWorkflowRun(input.run);
  if (!run || run.repo_id !== repo.id) {
    inputError(`run #${input.run} not found in ${input.repo}`);
  }
  return run;
}

const defaultDeps: WorkflowWatchDeps = {
  startedEventId(run) {
    return S.workflowRunStartedEventId(run.repo_id, run.id);
  },
  readNextEvent(input) {
    return S.nextWorkflowSubjectEvent(input);
  },
  wait() {
    return new Promise((resolve) => setTimeout(resolve, 1_000));
  },
  log: logWorkflowWatcher,
};

export const workflowWatch = {
  beginEffect(input: {
    repo: string;
    run: number;
    event: number;
    effect: string;
  }) {
    validateRepo(input.repo);
    validateEffect(input.effect);
    runInRepo(input);
    const result = S.beginWorkflowEventEffect(
      input.run,
      input.event,
      input.effect,
    );
    if (!result) {
      inputError(`event #${input.event} does not belong to run #${input.run}`);
    }
    return {
      run: input.run,
      event: input.event,
      effect: input.effect,
      status: result.row.status,
      execute: result.acquired,
      ambiguous: !result.acquired && result.row.status === "pending",
    };
  },

  completeEffect(input: {
    repo: string;
    run: number;
    event: number;
    effect: string;
  }) {
    validateRepo(input.repo);
    validateEffect(input.effect);
    runInRepo(input);
    const row = S.completeWorkflowEventEffect(
      input.run,
      input.event,
      input.effect,
    );
    if (!row) inputError(`effect receipt not found: ${input.effect}`);
    return {
      run: input.run,
      event: input.event,
      effect: input.effect,
      status: row.status,
      execute: false,
      ambiguous: false,
    };
  },

  // Block until one of the run's subjects records an event after `since`, then return it. `lh
  // workflow next --watch` owns the cursor around this wait.
  //
  // A run with no `workflow_run.started` event gets a visible error rather than a fallback to 0:
  // the start path writes the run row, its contract files and the event without a transaction, so
  // a missing start is a broken run an operator must decide about, not a backlog to replay.
  async waitForEvent(
    input: WorkflowEventWaitInput,
    deps: WorkflowWatchDeps = defaultDeps,
  ): Promise<LoopEvent> {
    const run = input.run;
    deps.log?.({
      event: "started",
      repo: input.repo,
      run: run.id,
      cursor: input.since,
    });
    const startedEventId = deps.startedEventId(run);
    if (startedEventId === null) {
      const message = `run #${run.id} has no workflow_run.started event`;
      deps.log?.({
        event: "failed",
        repo: input.repo,
        run: run.id,
        cursor: input.since,
        error: message,
      });
      inputError(message);
    }
    const afterId = workflowSubscriptionLowerBound(input.since, startedEventId);
    while (true) {
      let found: S.EventRow | null;
      try {
        // One event keeps each wait and the subsequent domain-state observation focused: the caller
        // reconciles from the state that event produced before waking on the next one. Advancing a
        // row at a time is also what keeps an unrelated event recorded between an old source and
        // its twin from being skipped.
        found = await deps.readNextEvent({
          repoId: run.repo_id,
          runId: run.id,
          issueNumber: run.issue_number,
          prNumber: run.pr_number,
          afterId,
        });
      } catch (error) {
        deps.log?.({
          event: "failed",
          repo: input.repo,
          run: run.id,
          cursor: afterId,
          error: errorMessage(error),
        });
        throw new Error(`workflow event: read failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      deps.log?.({
        event: "poll",
        repo: input.repo,
        run: run.id,
        cursor: afterId,
      });
      if (found) {
        deps.log?.({
          event: "delivered",
          repo: input.repo,
          run: run.id,
          cursor: found.id,
        });
        return formatEvent(found, input.repo);
      }
      try {
        await deps.wait();
      } catch (error) {
        deps.log?.({
          event: "failed",
          repo: input.repo,
          run: run.id,
          cursor: afterId,
          error: errorMessage(error),
        });
        throw new Error(`workflow event: wait failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }
  },
};
