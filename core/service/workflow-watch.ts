import { spawnSync } from "node:child_process";
import { events } from "./events.ts";

export const WORKFLOW_WATCH_WAKE = "orchestrator: workflow-events-ready";

export type WorkflowWatchInput = {
  repo: string;
  run: number;
  since: number;
  herdrSession: string;
  parentPane: string;
};

type WorkflowWatchDeps = {
  readEvents(input: {
    since: number;
    repo: string;
    types: ["workflow_run"];
    runId: number;
    order: "asc";
    limit: 1;
  }): unknown[] | Promise<unknown[]>;
  wait(): void | Promise<void>;
  deliver(input: WorkflowWatchInput, wake: string): void | Promise<void>;
};

const OPTION_NAMES = [
  "--repo",
  "--run",
  "--since",
  "--herdr-session",
  "--parent-pane",
] as const;

type OptionName = (typeof OPTION_NAMES)[number];

function inputError(message: string): never {
  throw new Error(`workflow watch: ${message}`);
}

function decimal(value: string, name: OptionName, positive: boolean): number {
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

function validateHerdrId(value: string, name: OptionName): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value)) {
    inputError(`invalid ${name}: ${value}`);
  }
}

export function parseWorkflowWatchArgs(args: string[]): WorkflowWatchInput {
  const values = new Map<OptionName, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index] as OptionName | undefined;
    if (!option || !OPTION_NAMES.includes(option)) {
      inputError(`unknown option: ${option ?? ""}`);
    }
    if (values.has(option)) inputError(`duplicate option: ${option}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      inputError(`${option} requires a value`);
    }
    values.set(option, value);
  }

  for (const option of OPTION_NAMES) {
    if (!values.has(option)) inputError(`missing required option: ${option}`);
  }

  const repo = values.get("--repo")!;
  const herdrSession = values.get("--herdr-session")!;
  const parentPane = values.get("--parent-pane")!;
  validateRepo(repo);
  validateHerdrId(herdrSession, "--herdr-session");
  validateHerdrId(parentPane, "--parent-pane");

  return {
    repo,
    run: decimal(values.get("--run")!, "--run", true),
    since: decimal(values.get("--since")!, "--since", false),
    herdrSession,
    parentPane,
  };
}

const defaultDeps: WorkflowWatchDeps = {
  readEvents(input) {
    return events.list(input);
  },
  wait() {
    return new Promise((resolve) => setTimeout(resolve, 1_000));
  },
  deliver(input, wake) {
    const result = spawnSync(
      "herdr",
      ["--session", input.herdrSession, "pane", "run", input.parentPane, wake],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.signal)
      throw new Error(`herdr terminated by signal ${result.signal}`);
    if (result.status !== 0) {
      throw new Error(`herdr exited with status ${result.status}`);
    }
  },
};

export const workflowWatch = {
  async watch(
    input: WorkflowWatchInput,
    deps: WorkflowWatchDeps = defaultDeps,
  ): Promise<void> {
    while (true) {
      let found: unknown[];
      try {
        found = await deps.readEvents({
          since: input.since,
          repo: input.repo,
          types: ["workflow_run"],
          runId: input.run,
          order: "asc",
          limit: 1,
        });
      } catch (error) {
        throw new Error(
          `workflow watch: event read failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (found.length > 0) {
        try {
          await deps.deliver(input, WORKFLOW_WATCH_WAKE);
        } catch (error) {
          throw new Error(
            `workflow watch: Herdr delivery failed: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        return;
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
