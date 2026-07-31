import * as S from "../store.ts";

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

export const workflowEffects = {
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
};
