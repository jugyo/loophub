import type { LoopEvent } from "../events.ts";
import * as S from "../store.ts";
import { events } from "./events.ts";

export type WorkflowWatchInput = {
  repo: string;
  run: number;
  since: number;
};

export type WorkflowWatchResult = {
  run: number;
  events: LoopEvent[];
  next_since: number;
};

type WorkflowWatchRun = {
  id: number;
  repo_id: number;
};

type WorkflowWatchDeps = {
  getRepo(repo: string): { id: number } | null;
  getRun(run: number): WorkflowWatchRun | null;
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

const VALUE_OPTIONS = ["--repo", "--run", "--since"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

function inputError(message: string): never {
  throw new Error(`workflow watch: ${message}`);
}

function decimal(value: string, name: ValueOption, positive: boolean): number {
  if (!/^[0-9]+$/.test(value)) inputError(`invalid ${name}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
    inputError(`invalid ${name}: ${value}`);
  }
  return parsed;
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

function runInRepo(input: { repo: string; run: number }): WorkflowWatchRun {
  const [owner, name] = input.repo.split("/");
  const repo = S.getRepo(owner, name);
  if (!repo) inputError(`repository not found: ${input.repo}`);
  const run = S.getWorkflowRun(input.run);
  if (!run || run.repo_id !== repo.id) {
    inputError(`run #${input.run} not found in ${input.repo}`);
  }
  return run;
}

export function parseWorkflowWatchArgs(args: string[]): WorkflowWatchInput {
  const values = new Map<ValueOption, string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === "--json") continue;
    const option = raw as ValueOption | undefined;
    if (!option || !VALUE_OPTIONS.includes(option)) {
      inputError(`unknown option: ${option ?? ""}`);
    }
    if (values.has(option)) inputError(`duplicate option: ${option}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      inputError(`${option} requires a value`);
    }
    values.set(option, value);
    index += 1;
  }

  for (const option of VALUE_OPTIONS) {
    if (!values.has(option)) inputError(`missing required option: ${option}`);
  }

  const repo = values.get("--repo")!;
  validateRepo(repo);
  return {
    repo,
    run: decimal(values.get("--run")!, "--run", true),
    since: decimal(values.get("--since")!, "--since", false),
  };
}

const defaultDeps: WorkflowWatchDeps = {
  getRepo(repo) {
    const [owner, name] = repo.split("/");
    return S.getRepo(owner, name);
  },
  getRun(run) {
    return S.getWorkflowRun(run);
  },
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

  async watch(
    input: WorkflowWatchInput,
    deps: WorkflowWatchDeps = defaultDeps,
  ): Promise<WorkflowWatchResult> {
    const repo = deps.getRepo(input.repo);
    if (!repo) inputError(`repository not found: ${input.repo}`);
    const run = deps.getRun(input.run);
    if (!run || run.repo_id !== repo.id) {
      inputError(`run #${input.run} not found in ${input.repo}`);
    }

    while (true) {
      let found: LoopEvent[];
      try {
        found = await deps.readEvents({
          since: input.since,
          repo: input.repo,
          types: ["workflow_run"],
          runId: input.run,
          order: "asc",
          // One event keeps each wait and subsequent domain-state observation focused. The result
          // carries the next cursor; presentation layers decide how to expose the next invocation.
          limit: 1,
        });
      } catch (error) {
        throw new Error(
          `workflow watch: event read failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (found.length > 0) {
        const nextSince = found[0].id;
        return {
          run: input.run,
          events: found,
          next_since: nextSince,
        };
      }
      try {
        await deps.wait();
      } catch (error) {
        throw new Error(`workflow watch: wait failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }
  },
};
