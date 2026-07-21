import type { WorkflowStep } from "./compose.ts";

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Strip control characters (incl. newlines) and Unicode bidi-override/isolate chars, then collapse
// whitespace, so a value shown as prose in an agent prompt cannot inject fake prompt structure or
// spoof the displayed text. Used for the human/agent-readable copies of the repo/workflow names; the
// shell-quoted forms passed to commands keep the real value. The unsafe-char class mirrors
// normalizeAgentName in core/terminal/terminal-launch.ts (C0/C1 controls + DEL + bidi controls).
export function inlineText(value: string): string {
  return value
    .replace(/[\x00-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parentUserPrompt(input: {
  runId: number;
  repoName: string;
  workflowName: string;
  issueNumber: number;
  prNumber: number;
  baseRef: string;
}): string {
  const repo = shellArg(input.repoName);
  return [
    "## Run context",
    `run: ${input.runId}`,
    `workflow: ${inlineText(input.workflowName)}`,
    `repo: ${inlineText(input.repoName)} (pass --repo ${repo} on every lh command)`,
    `issue: #${input.issueNumber}`,
    `pr: #${input.prNumber}`,
    "current step: execute",
    `worktree: . (cwd. base branch: ${input.baseRef})`,
    "",
    "## Instruction",
    "Orchestrate this run through Execute -> Verify as described in your contract.",
    `Decide every transition by observing \`lh workflow step status ${input.runId} --repo ${repo} --json\` after a watcher wake and event drain; the wake, pane output, and PR body markers are never transition facts.`,
    "Start now:",
    `1. Seed the event cursor from the newest event id: \`lh events --repo ${repo} --order desc --limit 1 --json\` (use 0 when empty).`,
    `2. Launch the Execute child: \`lh workflow launch-step --repo ${repo} --run ${input.runId} --step execute\`.`,
    `3. With \`HERDR_ENV=1\`, create \`\${LOOPHUB_HOME:-$HOME/.loophub}/logs/workflow-parent-watch\` and arm one detached watcher: \`nohup lh workflow watch --repo ${repo} --run ${input.runId} --since "$cursor" --herdr-session "$HERDR_SESSION" --parent-pane "$HERDR_PANE_ID" >>"\${LOOPHUB_HOME:-$HOME/.loophub}/logs/workflow-parent-watch/run-${input.runId}.log" 2>&1 </dev/null &\`.`,
    "4. Set `watcher_armed=true` and end the model turn; only the detached `lh` process polls while waiting.",
    `5. On the exact wake \`orchestrator: workflow-events-ready\`, set \`watcher_armed=false\`, drain \`lh events --since <cursor> --repo ${repo} --type workflow_run --run ${input.runId} --order asc --json\` to empty while advancing the cursor only to the largest processed event id, re-observe step status for transitions, then re-arm exactly one watcher at the latest cursor.`,
    "Then follow your contract's transition table, rework, and escalation for the remaining steps. Do not invoke slash-style commands.",
    "",
  ].join("\n");
}

export function stepContractForLaunch(
  _step: WorkflowStep,
  template: string,
): string {
  return template;
}

export function workflowStepPrompt(
  workflow: { [K in `${WorkflowStep}_prompt`]: string },
  step: WorkflowStep,
): string {
  return workflow[`${step}_prompt` as const];
}
