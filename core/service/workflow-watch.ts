import type { LoopEvent } from "../events.ts";
import * as S from "../store.ts";
import { events } from "./events.ts";

export type WorkflowEventWaitInput = {
  repo: string;
  run: number;
  since: number;
};

type WorkflowWatchDeps = {
  readEvents(input: {
    since: number;
    repo: string;
    types: ["workflow_run"];
    runId: number;
    order: "asc";
    limit: 1;
  }): LoopEvent[] | Promise<LoopEvent[]>;
  wait(): void | Promise<void>;
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
  readEvents(input) {
    return events.list(input);
  },
  wait() {
    return new Promise((resolve) => setTimeout(resolve, 1_000));
  },
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

  // Block until the run has an event after `since`, then return that single event. `lh workflow
  // next --watch` owns the cursor around this wait; callers of this helper have already resolved
  // the repo and run.
  async waitForEvent(
    input: WorkflowEventWaitInput,
    deps: WorkflowWatchDeps = defaultDeps,
  ): Promise<LoopEvent> {
    while (true) {
      let found: LoopEvent[];
      try {
        found = await deps.readEvents({
          since: input.since,
          repo: input.repo,
          types: ["workflow_run"],
          runId: input.run,
          order: "asc",
          // One event keeps each wait and the subsequent domain-state observation focused: the
          // caller reconciles from the state that event produced before waking on the next one.
          limit: 1,
        });
      } catch (error) {
        throw new Error(`workflow event: read failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      if (found.length > 0) return found[0];
      try {
        await deps.wait();
      } catch (error) {
        throw new Error(`workflow event: wait failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }
  },
};
