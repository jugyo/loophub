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

export function workflowHerdrPaneKind(
  name: unknown,
  runId: number,
): WorkflowHerdrPaneKind | null {
  const agent = parseWorkflowHerdrAgentName(name);
  if (agent) return agent.runId === runId ? agent.kind : null;
  if (typeof name !== "string") return null;

  // Existing runs can outlive a deployment. Keep their legacy panes recognizable so the first
  // restart or rework launch after an upgrade can rebuild the tab using the new child name.
  if (/^workflow-[0-9a-f]{8}$/iu.test(name)) return "parent";
  const legacyStep = name.match(/^workflow (?:execute|verify) #(\d+)$/u);
  return legacyStep && Number(legacyStep[1]) === runId ? "step" : null;
}

export function nextWorkflowChildSequence(stepSessionsJson: string): number {
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
  const count = (["execute", "verify"] as const).reduce((total, step) => {
    const stepSessions = history[step];
    if (stepSessions !== undefined && !Array.isArray(stepSessions)) {
      throw new Error("invalid Workflow step session history");
    }
    return total + (stepSessions?.length ?? 0);
  }, 0);
  return count + 1;
}
