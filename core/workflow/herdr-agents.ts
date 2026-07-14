import type { WorkflowStep } from "./compose.ts";

export type WorkflowHerdrAgent =
  | { kind: "parent"; runId: number }
  | {
      kind: "step";
      runId: number;
      step: WorkflowStep;
      sequence: number;
    };

export type WorkflowHerdrPaneKind = "parent" | "step";

export type LegacyWorkflowStepHerdrAgent = {
  kind: "step";
  runId: number;
  step: WorkflowStep;
};

const STEP_ROLE: Record<WorkflowStep, "executor" | "verifier"> = {
  execute: "executor",
  verify: "verifier",
};

export function workflowParentHerdrAgentName(runId: number): string {
  return `orchestrator #${runId}`;
}

export function workflowStepHerdrAgentName(
  runId: number,
  step: WorkflowStep,
  sequence: number,
): string {
  return `${STEP_ROLE[step]} #${runId}-${sequence}`;
}

export function parseWorkflowHerdrAgentName(
  name: unknown,
): WorkflowHerdrAgent | null {
  if (typeof name !== "string") return null;
  const parent = name.match(/^orchestrator #([1-9]\d*)$/u);
  if (parent) return { kind: "parent", runId: Number(parent[1]) };
  const child = name.match(/^(executor|verifier) #([1-9]\d*)-([1-9]\d*)$/u);
  if (!child) return null;
  return {
    kind: "step",
    runId: Number(child[2]),
    step: child[1] === "executor" ? "execute" : "verify",
    sequence: Number(child[3]),
  };
}

export function parseLegacyWorkflowStepHerdrAgentName(
  name: unknown,
): LegacyWorkflowStepHerdrAgent | null {
  if (typeof name !== "string") return null;
  const child = name.match(
    /^workflow (execute|verify)(?: run)? #([1-9]\d*)$/iu,
  );
  if (!child) return null;
  return {
    kind: "step",
    runId: Number(child[2]),
    step: child[1] as WorkflowStep,
  };
}

export function parseLegacyWorkflowParentHerdrAgentName(
  name: unknown,
): string | null {
  if (typeof name !== "string") return null;
  return name.match(/^workflow-([0-9a-f]{8})$/iu)?.[1] ?? null;
}

export function workflowHerdrPaneKind(
  name: unknown,
  runId: number,
): WorkflowHerdrPaneKind | null {
  const agent = parseWorkflowHerdrAgentName(name);
  if (agent) return agent.runId === runId ? agent.kind : null;
  if (typeof name !== "string") return null;

  // Existing runs can outlive a deployment. Keep their legacy panes recognizable so the first
  // restart or rework launch after an upgrade can rebuild the tab using the new child name.
  if (parseLegacyWorkflowParentHerdrAgentName(name)) return "parent";
  const legacyStep = parseLegacyWorkflowStepHerdrAgentName(name);
  return legacyStep?.runId === runId ? "step" : null;
}

function workflowStepSessionHistory(
  stepSessionsJson: string,
): Record<string, string[]> {
  let sessions: unknown;
  try {
    sessions = JSON.parse(stepSessionsJson);
  } catch (error) {
    throw new Error("invalid Workflow step session history", { cause: error });
  }
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    throw new Error("invalid Workflow step session history");
  }
  const history = sessions as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const step of ["execute", "verify"] as const) {
    const stepSessions = history[step];
    if (stepSessions === undefined) continue;
    if (
      !Array.isArray(stepSessions) ||
      stepSessions.some((session) => typeof session !== "string")
    ) {
      throw new Error("invalid Workflow step session history");
    }
    out[step] = stepSessions;
  }
  return out;
}

export function workflowStepSessionIds(
  stepSessionsJson: string,
  step: WorkflowStep,
): string[] {
  try {
    const sessions = JSON.parse(stepSessionsJson) as unknown;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
      return [];
    }
    const stepSessions = (sessions as Record<string, unknown>)[step];
    return Array.isArray(stepSessions)
      ? stepSessions.filter(
          (session): session is string => typeof session === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function nextWorkflowChildSequence(stepSessionsJson: string): number {
  const history = workflowStepSessionHistory(stepSessionsJson);
  const count = (["execute", "verify"] as const).reduce(
    (total, step) => total + (history[step]?.length ?? 0),
    0,
  );
  return count + 1;
}
