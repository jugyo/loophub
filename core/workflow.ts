// `.loophub/workflow.yml` loader + the pure pieces the worker (worker/) needs to dispatch
// events to shell commands. Kept in core so it is covered by the core test suite and so the
// worker process layer stays thin. v1 is an intentionally flat `on.<event> -> run[]` map (see
// issue #52): no DAG, no `if:`, no template expansion — just event -> commands.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LoopEvent } from "./event-hub.ts";
import type { Worktree } from "./git.ts";

/** Repo-relative path of the workflow file (VCS-managed, portable). */
export const WORKFLOW_PATH = ".loophub/workflow.yml";

/** Events the worker dispatches on in v1. Other event types are read but never matched. */
export const SUPPORTED_EVENTS = ["issue.opened", "pull_request.opened"] as const;

export interface WorkflowStep {
  run: string;
}

export interface Workflow {
  /** event type (e.g. "issue.opened") -> ordered list of run steps */
  on: Record<string, WorkflowStep[]>;
}

// Coerce an arbitrary parsed YAML value into a Workflow, dropping anything that does not fit
// the v1 schema. Unknown keys and malformed steps are ignored rather than rejected so a typo
// in one section never takes the whole worker down (issue #52: "壊れた設定で worker が落ちない").
export function normalizeWorkflow(doc: unknown): Workflow {
  const on: Record<string, WorkflowStep[]> = {};
  const onMap = (doc as any)?.on;
  if (onMap && typeof onMap === "object") {
    for (const [event, steps] of Object.entries(onMap)) {
      if (!Array.isArray(steps)) continue;
      const runs: WorkflowStep[] = [];
      for (const step of steps) {
        const run = (step as any)?.run;
        if (typeof run === "string" && run.trim() !== "") runs.push({ run });
      }
      if (runs.length > 0) on[event] = runs;
    }
  }
  return { on };
}

/** Parse workflow YAML text. Throws on invalid YAML; callers that must not crash use loadWorkflow. */
export function parseWorkflow(text: string): Workflow {
  return normalizeWorkflow(parseYaml(text));
}

// Load + parse the repo's workflow file. Returns null when the file is absent (no workflow)
// or unparseable (logged, not thrown) — the worker continues either way.
export function loadWorkflow(repoLocalPath: string): Workflow | null {
  let text: string;
  try {
    text = readFileSync(join(repoLocalPath, WORKFLOW_PATH), "utf8");
  } catch {
    return null; // no workflow.yml in this repo
  }
  try {
    return parseWorkflow(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`workflow: ignoring invalid ${WORKFLOW_PATH} in ${repoLocalPath}: ${msg}`);
    return null;
  }
}

/** Steps configured for an event type, or [] when none. */
export function stepsFor(workflow: Workflow, eventType: string): WorkflowStep[] {
  return workflow.on[eventType] ?? [];
}

// Resolve a PR head ref to an on-disk worktree path via `git worktree list` output (passed in
// as parsed Worktree[]). The match is by branch name, not LoopHub's naming convention, so the
// runner stays agnostic to where worktrees live (issue #52 boundary note). Returns "" when the
// ref has no checked-out worktree (e.g. a regular branch) — callers set LH_WORKTREE_PATH="".
export function matchWorktreePath(headRef: string | null | undefined, worktrees: Worktree[]): string {
  if (!headRef) return "";
  const wt = worktrees.find((w) => w.branch === headRef);
  return wt ? wt.path : "";
}

export interface RunContext {
  event: Pick<LoopEvent, "type" | "actor" | "payload">;
  repoFullName: string;
  issueNumber?: number;
  prNumber?: number;
  /** PR events: matched worktree path or "" (always set). Issue events: undefined (unset). */
  worktreePath?: string;
}

// Build the LH_* environment a run step is spawned with. Only the variables relevant to the
// event are set: LH_ISSUE_NUMBER / LH_PR_NUMBER are conditional, and LH_WORKTREE_PATH is set
// (possibly to "") only for PR events where ctx.worktreePath is provided.
export function buildRunEnv(ctx: RunContext): Record<string, string> {
  const env: Record<string, string> = {
    LH_EVENT_TYPE: ctx.event.type,
    LH_REPO: ctx.repoFullName,
    LH_ACTOR: ctx.event.actor,
    LH_EVENT_PAYLOAD: JSON.stringify(ctx.event.payload ?? {}),
  };
  if (ctx.issueNumber != null) env.LH_ISSUE_NUMBER = String(ctx.issueNumber);
  if (ctx.prNumber != null) env.LH_PR_NUMBER = String(ctx.prNumber);
  if (ctx.worktreePath != null) env.LH_WORKTREE_PATH = ctx.worktreePath;
  return env;
}
